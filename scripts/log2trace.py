#!/usr/bin/env python3
"""Log-to-Trace bridge: tails cagent debug logs and sends OTLP traces to Tempo.

Workaround for cagent v1.39.0 --otel schema conflict bug.
Parses logfmt entries, groups by session_id, builds trace spans, POSTs to Tempo.
"""

import json
import os
import re
import sys
import time
import uuid
from http.client import HTTPConnection

TEMPO_HOST = os.environ.get("TEMPO_HOST", "tempo")
TEMPO_PORT = int(os.environ.get("TEMPO_PORT", "4318"))
SERVICE_NAME = os.environ.get("OTEL_SERVICE_NAME", "tech-pulse-agent")
LOG_FILES = [
    "/var/log/dev-agent-debug.log",
    "/var/log/news-agent-debug.log",
]
FLUSH_TIMEOUT = 30  # seconds after last event before flushing session


def parse_logfmt(line):
    """Parse a logfmt line into a dict."""
    result = {}
    for m in re.finditer(r'(\w+)=(?:"((?:[^"\\]|\\.)*)"|(\S+))', line):
        key = m.group(1)
        val = m.group(2) if m.group(2) is not None else m.group(3)
        result[key] = val
    return result


def iso_to_nanos(ts):
    """Convert ISO timestamp to unix nanoseconds."""
    try:
        ts = ts.rstrip("Z")
        parts = ts.split(".")
        base = time.mktime(time.strptime(parts[0], "%Y-%m-%dT%H:%M:%S"))
        frac = float("0." + parts[1]) if len(parts) > 1 else 0
        return int((base + frac) * 1_000_000_000)
    except Exception:
        return int(time.time() * 1_000_000_000)


def gen_trace_id():
    return uuid.uuid4().hex


def gen_span_id():
    return uuid.uuid4().hex[:16]


MAX_ATTR_LEN = 4096  # max attribute value length

# Fields to skip when bulk-capturing logfmt entries
SKIP_FIELDS = {"time", "level", "msg", "session_id", "caller"}


def entry_to_attrs(entry, prefix=""):
    """Convert all logfmt fields from an entry into span attributes dict.

    Skips internal fields (time, level, msg, session_id, caller).
    Adds optional prefix to keys (e.g. 'result.' for tool results).
    """
    attrs = {}
    for k, v in entry.items():
        if k in SKIP_FIELDS:
            continue
        key = "{}{}".format(prefix, k) if prefix else k
        attrs[key] = str(v)[:MAX_ATTR_LEN]
    return attrs


def make_span(trace_id, span_id, parent_span_id, name, start_ns, end_ns, attributes=None):
    """Build an OTLP span dict."""
    span = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": 1,
        "startTimeUnixNano": str(start_ns),
        "endTimeUnixNano": str(end_ns),
        "attributes": [],
        "status": {},
    }
    if parent_span_id:
        span["parentSpanId"] = parent_span_id
    if attributes:
        for k, v in attributes.items():
            span["attributes"].append({
                "key": k,
                "value": {"stringValue": str(v)[:MAX_ATTR_LEN]}
            })
    return span


def send_trace(spans):
    """POST OTLP JSON trace to Tempo."""
    if not spans:
        return
    payload = {
        "resourceSpans": [{
            "resource": {
                "attributes": [
                    {"key": "service.name", "value": {"stringValue": SERVICE_NAME}},
                ]
            },
            "scopeSpans": [{
                "scope": {"name": "log2trace"},
                "spans": spans,
            }]
        }]
    }
    try:
        conn = HTTPConnection(TEMPO_HOST, TEMPO_PORT, timeout=5)
        body = json.dumps(payload)
        conn.request("POST", "/v1/traces", body=body,
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        resp.read()
        conn.close()
        if resp.status < 300:
            print("[log2trace] Sent trace with {} spans".format(len(spans)), flush=True)
        else:
            print("[log2trace] Tempo returned {}".format(resp.status), flush=True)
    except Exception as e:
        print("[log2trace] Failed to send trace: {}".format(e), flush=True)


class SessionTracer:
    """Tracks spans for a single agent session."""

    def __init__(self, session_id, timestamp, agent_type="unknown"):
        self.session_id = session_id
        self.agent_type = agent_type
        self.trace_id = gen_trace_id()
        self.root_span_id = gen_span_id()
        self.start_ns = timestamp
        self.last_event_ns = timestamp
        self.spans = []
        self.current_agent = "root"
        self.agent_spans = {}
        self.pending_tool = None
        self.pending_llm = None

    def _parent_for_agent(self, agent_name):
        if agent_name in self.agent_spans:
            return self.agent_spans[agent_name]
        return self.root_span_id

    def on_transfer_task(self, ts, entry):
        to_agent = entry.get("to_agent", entry.get("to", "unknown"))
        span_id = gen_span_id()
        self.agent_spans[to_agent] = span_id
        self.last_event_ns = ts
        attrs = {"target.agent": to_agent, "agent.name": self.current_agent}
        attrs.update(entry_to_attrs(entry))
        self.spans.append(make_span(
            self.trace_id, span_id, self.root_span_id,
            "transfer_task -> {}".format(to_agent),
            ts, ts + 1_000_000, attrs
        ))

    def on_conversation_stopped(self, ts, agent_name, entry=None):
        self.last_event_ns = ts
        if agent_name in self.agent_spans:
            span_id = self.agent_spans[agent_name]
            for s in self.spans:
                if s["spanId"] == span_id:
                    s["endTimeUnixNano"] = str(ts)
                    # Add stop reason and any other fields to the agent span
                    if entry:
                        for k, v in entry_to_attrs(entry, prefix="stop.").items():
                            s["attributes"].append({
                                "key": k,
                                "value": {"stringValue": str(v)[:MAX_ATTR_LEN]}
                            })
                    break

    def on_tool_call(self, ts, entry):
        parent = self._parent_for_agent(self.current_agent)
        tool_name = entry.get("tool_name", entry.get("tool", "unknown"))
        span_id = gen_span_id()
        attrs = {"tool.name": tool_name, "agent.name": self.current_agent}
        # Capture all fields from the call event (arguments, parameters, etc.)
        attrs.update(entry_to_attrs(entry, prefix="tool.call."))
        self.pending_tool = (span_id, tool_name, ts, parent, attrs)
        self.last_event_ns = ts

    def on_tool_completed(self, ts, entry):
        self.last_event_ns = ts
        if self.pending_tool:
            sid, name, start, parent, attrs = self.pending_tool
            # Capture all fields from the completion event (result, output, status, etc.)
            attrs.update(entry_to_attrs(entry, prefix="tool.result."))
            self.spans.append(make_span(
                self.trace_id, sid, parent,
                "tool: {}".format(name), start, ts, attrs
            ))
            self.pending_tool = None

    def on_shell_exec(self, ts, entry):
        parent = self._parent_for_agent(self.current_agent)
        cmd = entry.get("command", entry.get("cmd", ""))
        span_id = gen_span_id()
        attrs = {"tool.name": "shell", "agent.name": self.current_agent}
        # Capture all fields (full command, working dir, etc.)
        attrs.update(entry_to_attrs(entry, prefix="shell."))
        self.spans.append(make_span(
            self.trace_id, span_id, parent,
            "shell: {}".format(cmd[:200]), ts, ts + 1_000_000, attrs
        ))
        self.last_event_ns = ts

    def on_llm_start(self, ts, entry):
        parent = self._parent_for_agent(self.current_agent)
        model = entry.get("model", "unknown")
        span_id = gen_span_id()
        attrs = {"agent.name": self.current_agent}
        # Capture all fields from the LLM request (model, message_count, tool_count,
        # temperature, max_tokens, provider, api_base, etc.)
        attrs.update(entry_to_attrs(entry, prefix="llm.request."))
        # Also set canonical llm.model for easy querying
        attrs["llm.model"] = model
        self.pending_llm = (span_id, ts, parent, attrs)
        self.last_event_ns = ts

    def on_llm_end(self, ts, entry):
        self.last_event_ns = ts
        if self.pending_llm:
            sid, start, parent, attrs = self.pending_llm
            # Capture all fields from the response (tokens, finish_reason, etc.)
            attrs.update(entry_to_attrs(entry, prefix="llm.response."))
            # Extract token usage with canonical attribute names
            for field in ("input_tokens", "prompt_tokens"):
                val = entry.get(field)
                if val is not None:
                    attrs["llm.input_tokens"] = str(val)
                    break
            for field in ("output_tokens", "completion_tokens"):
                val = entry.get(field)
                if val is not None:
                    attrs["llm.output_tokens"] = str(val)
                    break
            for field in ("total_tokens",):
                val = entry.get(field)
                if val is not None:
                    attrs["llm.total_tokens"] = str(val)
                    break
            # Calculate total if not provided
            if "llm.total_tokens" not in attrs:
                try:
                    inp = int(attrs.get("llm.input_tokens", 0))
                    out = int(attrs.get("llm.output_tokens", 0))
                    if inp or out:
                        attrs["llm.total_tokens"] = str(inp + out)
                except (ValueError, TypeError):
                    pass
            self.spans.append(make_span(
                self.trace_id, sid, parent,
                "llm: {}".format(attrs.get("llm.model", "?")), start, ts, attrs
            ))
            self.pending_llm = None

    def on_agent_change(self, agent_name):
        self.current_agent = agent_name

    def flush(self, end_ns=None):
        if end_ns is None:
            end_ns = self.last_event_ns
        if self.pending_tool:
            sid, name, start, parent, attrs = self.pending_tool
            self.spans.append(make_span(
                self.trace_id, sid, parent, "tool: {}".format(name), start, end_ns, attrs))
            self.pending_tool = None
        if self.pending_llm:
            sid, start, parent, attrs = self.pending_llm
            self.spans.append(make_span(
                self.trace_id, sid, parent,
                "llm: {}".format(attrs.get("llm.model", "?")), start, end_ns, attrs))
            self.pending_llm = None

        root = make_span(
            self.trace_id, self.root_span_id, None,
            "session: {}".format(self.session_id[:8]),
            self.start_ns, end_ns,
            {"session.id": self.session_id, "agent.type": self.agent_type}
        )
        all_spans = [root] + self.spans
        send_trace(all_spans)


def tail_files(paths, poll_interval=1.0):
    """Tail multiple files, yielding (line, filepath) tuples."""
    files = {}
    for p in paths:
        try:
            f = open(p, "r")
            f.seek(0, 2)
            files[p] = f
        except FileNotFoundError:
            pass

    while True:
        got_line = False
        for p in list(paths):
            if p not in files:
                try:
                    f = open(p, "r")
                    f.seek(0, 2)
                    files[p] = f
                except FileNotFoundError:
                    continue

            line = files[p].readline()
            if line:
                got_line = True
                yield line.strip(), p
            else:
                try:
                    pos = files[p].tell()
                    size = os.fstat(files[p].fileno()).st_size
                    if pos > size:
                        files[p].seek(0)
                except Exception:
                    pass

        if not got_line:
            time.sleep(poll_interval)


def main():
    print("[log2trace] Starting log-to-trace bridge", flush=True)
    print("[log2trace] Tempo: {}:{}".format(TEMPO_HOST, TEMPO_PORT), flush=True)
    print("[log2trace] Watching: {}".format(LOG_FILES), flush=True)

    time.sleep(5)

    sessions = {}
    last_sid = ""

    for line, filepath in tail_files(LOG_FILES):
        entry = parse_logfmt(line)
        msg = entry.get("msg", "")
        ts = iso_to_nanos(entry.get("time", ""))
        sid = entry.get("session_id", "")
        agent_type = "dev-agent" if "dev-agent" in filepath else "news-agent"

        # Flush stale sessions
        now_ns = int(time.time() * 1_000_000_000)
        stale = [k for k, v in sessions.items()
                 if now_ns - v.last_event_ns > FLUSH_TIMEOUT * 1_000_000_000]
        for k in stale:
            print("[log2trace] Flushing stale session {}".format(k[:8]), flush=True)
            sessions[k].flush()
            del sessions[k]

        # Track last known session_id (many events don't include it)
        if sid:
            last_sid = sid
        else:
            sid = last_sid

        if not sid:
            continue

        if msg in ("Running agent", "Creating new session") and sid not in sessions:
            last_sid = sid
            sessions[sid] = SessionTracer(sid, ts, agent_type)
            agent = entry.get("current_agent", entry.get("agent", "root"))
            sessions[sid].on_agent_change(agent)

        elif sid not in sessions:
            if sessions:
                sid = list(sessions.keys())[-1]
            else:
                continue

        tracer = sessions.get(sid)
        if not tracer:
            continue

        if msg == "Transferring task to agent":
            tracer.on_transfer_task(ts, entry)
        elif msg == "Using agent":
            tracer.on_agent_change(entry.get("agent", "root"))
        elif msg == "Processing tool call":
            tracer.on_tool_call(ts, entry)
        elif msg == "Tool call completed":
            tracer.on_tool_completed(ts, entry)
        elif msg == "Tool auto-approved":
            # Enrich pending tool span with approval info
            if tracer.pending_tool:
                sid_t, name_t, start_t, parent_t, attrs_t = tracer.pending_tool
                attrs_t.update(entry_to_attrs(entry, prefix="tool.approval."))
                tracer.pending_tool = (sid_t, name_t, start_t, parent_t, attrs_t)
        elif msg == "Executing native shell command":
            tracer.on_shell_exec(ts, entry)
        elif msg == "Creating OpenAI chat completion stream":
            tracer.on_llm_start(ts, entry)
        elif msg in ("Model selected", "OpenAI chat completion request"):
            # Enrich pending LLM span with model selection / request details
            if tracer.pending_llm:
                sid_l, start_l, parent_l, attrs_l = tracer.pending_llm
                attrs_l.update(entry_to_attrs(entry, prefix="llm.config."))
                tracer.pending_llm = (sid_l, start_l, parent_l, attrs_l)
        elif msg == "Stream processed":
            tracer.on_llm_end(ts, entry)
        elif msg == "Conversation stopped":
            agent = entry.get("agent", "")
            tracer.on_conversation_stopped(ts, agent, entry)
            if agent == "root":
                tracer.flush(ts)
                if sid in sessions:
                    del sessions[sid]


if __name__ == "__main__":
    main()
