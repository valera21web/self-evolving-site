document.addEventListener('DOMContentLoaded', function () {
    var sidebar = document.getElementById('session-list');
    var chatMessages = document.getElementById('chat-messages');
    var chatInput = document.getElementById('chat-input');
    var sendBtn = document.getElementById('send-btn');
    var chatForm = document.getElementById('chat-form');
    var newSessionBtn = document.getElementById('new-session-btn');
    var renameBtn = document.getElementById('rename-btn');
    var deleteBtn = document.getElementById('delete-btn');
    var titleDisplay = document.getElementById('session-title-display');
    var statusDot = document.querySelector('.status-dot');
    var statusText = document.querySelector('.status-text');
    var planTracker = document.getElementById('plan-tracker');
    var filesChanged = document.getElementById('files-changed');
    var deployBtn = document.getElementById('deploy-btn');
    var discardBtn = document.getElementById('discard-btn');
    var reviewBtn = document.getElementById('review-btn');
    var commitBtn = document.getElementById('commit-btn');
    var diffModal = document.getElementById('diff-modal');
    var diffModalTitle = document.getElementById('diff-modal-title');
    var diffModalBody = document.getElementById('diff-modal-body');
    var diffModalClose = document.getElementById('diff-modal-close');

    var currentSessionId = null;
    var agentName = 'dev-agent';
    var isAgentWorking = false;
    var trackedFiles = new Set();
    var diffData = []; // cached diffs from /diff-api/diff-all
    var hasWorkdir = false;
    var isCommitted = false;
    var pollInterval = null;
    var lastPollCount = 0;
    var stablePollTicks = 0;

    // Plan steps matching the dev-agent multi-agent pipeline
    var STEPS = [
        { id: 'understand', label: 'Understanding the request' },
        { id: 'analyze', label: 'Analyzing files and structure' },
        { id: 'implement', label: 'Implementing changes' },
        { id: 'verify', label: 'Verifying changes' },
        { id: 'review', label: 'Your review & deploy' }
    ];
    var STEP_ORDER = ['understand', 'analyze', 'implement', 'verify', 'review'];
    var stepStates = {};
    var currentStepIndex = -1;
    var hasStarted = false;

    // Auto-approval messages to filter out
    var PHANTOM_MESSAGES = ['please proceed.', 'please proceed', 'yes', 'y', 'proceed', 'continue'];

    loadSessions();
    setTimeout(function () {
        if (!sidebar.children.length) loadSessions();
    }, 1000);

    newSessionBtn.addEventListener('click', createNewSession);
    renameBtn.addEventListener('click', renameSession);
    deleteBtn.addEventListener('click', deleteSession);
    deployBtn.addEventListener('click', deployChanges);
    discardBtn.addEventListener('click', discardChanges);
    reviewBtn.addEventListener('click', reviewChanges);
    commitBtn.addEventListener('click', commitChanges);
    diffModalClose.addEventListener('click', closeDiffModal);
    diffModal.addEventListener('click', function (e) {
        if (e.target === diffModal) closeDiffModal();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && diffModal.style.display !== 'none') closeDiffModal();
    });
    chatForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = chatInput.value.trim();
        if (!text || !currentSessionId || isAgentWorking) return;
        appendMessage('user', text);
        chatInput.value = '';
        sendToAgent(text);
    });

    function apiCall(method, path, body) {
        var opts = { method: method, credentials: 'same-origin', headers: {} };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        return fetch('/api' + path, opts);
    }

    // --- Sessions ---

    function loadSessions() {
        apiCall('GET', '/sessions').then(function (r) { return r.json(); })
        .then(function (sessions) {
            sidebar.textContent = '';
            if (!sessions || sessions.length === 0) {
                var p = document.createElement('p');
                p.className = 'muted';
                p.textContent = 'No sessions yet.';
                sidebar.appendChild(p);
                return;
            }
            sessions.forEach(function (s) {
                var div = document.createElement('div');
                div.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
                div.dataset.id = s.id;
                var title = document.createElement('span');
                title.className = 'session-item-title';
                title.textContent = s.title || 'Untitled';
                div.appendChild(title);
                var meta = document.createElement('span');
                meta.className = 'session-item-meta';
                meta.textContent = s.num_messages + ' msgs';
                div.appendChild(meta);
                div.addEventListener('click', function () { selectSession(s.id); });
                sidebar.appendChild(div);
            });
        });
    }

    function createNewSession() {
        apiCall('POST', '/sessions', {}).then(function (r) { return r.json(); })
        .then(function (data) {
            currentSessionId = data.id;
            // Create worktree eagerly and activate it
            fetch('/diff-api/activate', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: data.id, create: true })
            }).catch(function () {});
            loadSessions();
            loadSessionChat(data.id);
            enableChat();
        });
    }

    function selectSession(id) {
        currentSessionId = id;
        // Activate this session's worktree (switch symlink)
        fetch('/diff-api/activate', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: id })
        }).catch(function () {});
        loadSessions();
        loadSessionChat(id);
        enableChat();
    }

    function loadSessionChat(id) {
        resetProgressPanel();
        stopPolling();
        apiCall('GET', '/sessions/' + id).then(function (r) { return r.json(); })
        .then(function (data) {
            titleDisplay.textContent = data.title || 'Untitled Session';
            chatMessages.textContent = '';
            trackedFiles = new Set();

            var messages = data.messages || [];
            var allTools = []; // {name, args}
            var isFirstUserMsg = true;

            renderMessages(messages, allTools, isFirstUserMsg);

            // Reconstruct plan from history
            if (allTools.length > 0 || messages.length > 1) {
                reconstructPlanFromHistory(allTools);
            }
            updateFilesPanel();

            // Save message count for polling
            lastPollCount = messages.length;

            // Use worktree status for button visibility only (not plan tracker)
            // Plan tracker is driven solely by session's own tool call history above
            fetch('/diff-api/status', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (status) {
                if (status.worktree && trackedFiles.size > 0) {
                    // Worktree exists AND this session has tracked files — show buttons
                    hasWorkdir = true;
                    discardBtn.style.display = 'block';
                    reviewBtn.style.display = 'block';
                    fetchDiffs();
                    checkCommitStatus();
                } else if (!status.worktree && trackedFiles.size > 0 && hasStarted) {
                    // No worktree but session had work — deploy already done
                    completePlan();
                }

                detectAndReconnect(messages);
            })
            .catch(function () {
                detectAndReconnect(messages);
            });
        });
    }

    function renameSession() {
        if (!currentSessionId) return;
        var newTitle = prompt('New session name:');
        if (!newTitle) return;
        apiCall('PATCH', '/sessions/' + currentSessionId + '/title', { title: newTitle })
        .then(function () {
            titleDisplay.textContent = newTitle;
            loadSessions();
        });
    }

    function renderMessages(messages, allTools, isFirstUserMsg) {
        messages.forEach(function (m) {
            var msg = m.message;
            if (msg.role === 'user') {
                var text = (msg.content || '').trim();
                if (!isFirstUserMsg && PHANTOM_MESSAGES.indexOf(text.toLowerCase()) !== -1) {
                    return;
                }
                isFirstUserMsg = false;
                appendMessage('user', text);
            } else if (msg.role === 'assistant') {
                if (msg.content) {
                    appendMessage('agent', msg.content);
                    trackFilesFromText(msg.content);
                }
                if (msg.tool_calls) {
                    msg.tool_calls.forEach(function (tc) {
                        var fn = tc.function;
                        allTools.push({ name: fn.name, args: fn.arguments });
                        trackFileFromTool(fn.name, fn.arguments);
                        appendToolMessage(fn.name, fn.arguments);
                    });
                }
            }
        });
    }

    function detectAndReconnect(messages) {
        if (!messages || messages.length === 0) return;
        var last = messages[messages.length - 1].message;
        // Agent is likely still working if the last message has tool_calls
        // (it called a tool and we haven't seen the follow-up yet)
        var likelyWorking = last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0;
        if (likelyWorking) {
            startPolling();
        }
    }

    function startPolling() {
        if (pollInterval) return;
        if (!currentSessionId) return;
        isAgentWorking = true;
        setAgentStatus('working');
        sendBtn.disabled = true;
        chatInput.disabled = true;
        stablePollTicks = 0;

        // Get current message count before starting poll interval
        apiCall('GET', '/sessions/' + currentSessionId)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            var messages = data.messages || [];
            // Render any messages we haven't shown yet
            if (messages.length > lastPollCount) {
                var newMsgs = messages.slice(lastPollCount);
                var allTools = [];
                renderMessages(newMsgs, allTools, false);
                allTools.forEach(function (t) { updatePlanFromTool(t.name, t.args); });
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
            lastPollCount = messages.length;

            pollInterval = setInterval(function () {
            if (!currentSessionId) { stopPolling(); return; }
            apiCall('GET', '/sessions/' + currentSessionId)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var messages = data.messages || [];
                if (messages.length > lastPollCount) {
                    // New messages — append only the new ones
                    var newMsgs = messages.slice(lastPollCount);
                    var allTools = [];
                    renderMessages(newMsgs, allTools, false);
                    allTools.forEach(function (t) {
                        updatePlanFromTool(t.name, t.args);
                    });
                    lastPollCount = messages.length;
                    stablePollTicks = 0;
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                } else {
                    stablePollTicks++;
                    if (stablePollTicks >= 2) {
                        // No new messages for 2 polls — agent finished
                        stopPolling();
                        // Run finishAgent logic
                        var agentBubbles = chatMessages.querySelectorAll('.message.agent');
                        agentBubbles.forEach(function (b) { trackFilesFromText(b.textContent); });
                        updateFilesPanel();
                        if (hasStarted && currentStepIndex >= 0) {
                            stepStates[STEPS[currentStepIndex].id] = 'completed';
                            renderPlan();
                        }
                        if (trackedFiles.size > 0) {
                            hasWorkdir = true;
                            advanceToStep('review');
                            discardBtn.style.display = 'block';
                            reviewBtn.style.display = 'block';
                            fetchDiffs();
                            checkCommitStatus();
                        }
                        loadSessions();
                    }
                }
            })
            .catch(function () {
                stopPolling();
            });
        }, 3000);
        });
    }

    function stopPolling() {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        isAgentWorking = false;
        sendBtn.disabled = false;
        chatInput.disabled = false;
        setAgentStatus('idle');
    }

    function deleteSession() {
        if (!currentSessionId) return;
        if (!confirm('Delete this session?')) return;

        var sessionToDelete = currentSessionId;

        // Delete worktree and branch for this session
        var cleanup = fetch('/diff-api/delete', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: sessionToDelete })
        }).catch(function () {});

        cleanup.then(function () {
            return apiCall('DELETE', '/sessions/' + sessionToDelete);
        }).then(function () {
            currentSessionId = null;
            chatMessages.textContent = '';
            titleDisplay.textContent = 'Select or create a session';
            disableChat();
            loadSessions();
            resetProgressPanel();
        });
    }

    function enableChat() {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        renameBtn.disabled = false;
        deleteBtn.disabled = false;
    }

    function disableChat() {
        chatInput.disabled = true;
        sendBtn.disabled = true;
        renameBtn.disabled = true;
        deleteBtn.disabled = true;
    }

    // --- Chat Messages ---

    function appendMessage(role, content) {
        var div = document.createElement('div');
        div.className = 'message ' + role;
        renderTextContent(div, content);
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return div;
    }

    function appendSystemMessage(content) {
        var div = document.createElement('div');
        div.className = 'message system';
        div.textContent = content;
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return div;
    }

    function appendToolMessage(toolName, argsStr) {
        var div = document.createElement('div');
        div.className = 'message tool-call';

        var header = document.createElement('div');
        header.className = 'tool-header';

        var toggle = document.createElement('span');
        toggle.className = 'tool-toggle';
        toggle.textContent = '\u25B6'; // ▶

        var label = document.createElement('span');
        label.className = 'tool-name';
        label.textContent = formatToolName(toolName, argsStr);

        header.appendChild(toggle);
        header.appendChild(label);
        div.appendChild(header);

        // Detail section (collapsed)
        var detail = document.createElement('div');
        detail.className = 'tool-detail';
        try {
            var args = JSON.parse(argsStr || '{}');
            detail.textContent = JSON.stringify(args, null, 2);
        } catch (e) {
            detail.textContent = argsStr || '';
        }
        div.appendChild(detail);

        div.addEventListener('click', function () {
            div.classList.toggle('expanded');
        });

        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return div;
    }

    function formatToolName(toolName, argsStr) {
        if (toolName === 'transfer_task') {
            try {
                var args = JSON.parse(argsStr || '{}');
                var target = args.agent || args.target || '';
                if (target) return 'Delegating to ' + target;
            } catch (e) {}
            return 'Delegating task';
        }
        if (toolName === 'read_file' || toolName === 'read_multiple_files') return 'Reading files';
        if (toolName === 'write_file') {
            try {
                var a = JSON.parse(argsStr || '{}');
                if (a.path) return 'Writing ' + formatPath(a.path);
            } catch (e) {}
            return 'Writing file';
        }
        if (toolName === 'edit_file') return 'Editing file';
        if (toolName === 'directory_tree') return 'Scanning directory tree';
        if (toolName === 'list_directory') return 'Listing directory';
        if (toolName === 'search_files_content') return 'Searching files';
        if (toolName === 'shell') {
            try {
                var sa = JSON.parse(argsStr || '{}');
                var cmd = sa.command || sa.cmd || '';
                if (cmd.length > 60) cmd = cmd.substring(0, 60) + '...';
                if (cmd) return 'Running: ' + cmd;
            } catch (e) {}
            return 'Running shell command';
        }
        return toolName;
    }

    function renderTextContent(div, text) {
        while (div.firstChild) div.removeChild(div.firstChild);
        var parts = (text || '').split(/(```[\s\S]*?```)/g);
        parts.forEach(function (part) {
            if (part.startsWith('```') && part.endsWith('```')) {
                var pre = document.createElement('pre');
                var code = document.createElement('code');
                code.textContent = part.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
                pre.appendChild(code);
                div.appendChild(pre);
            } else if (part) {
                part.split('\n').forEach(function (line, i, arr) {
                    var span = document.createElement('span');
                    span.textContent = line;
                    div.appendChild(span);
                    if (i < arr.length - 1) div.appendChild(document.createElement('br'));
                });
            }
        });
    }

    // --- Agent Communication (SSE) ---

    function sendToAgent(message) {
        if (!currentSessionId) return;
        stopPolling();
        setAgentStatus('working');
        isAgentWorking = true;
        sendBtn.disabled = true;
        chatInput.disabled = true;

        // Reset plan for new round if previous round completed
        if (hasStarted && currentStepIndex >= STEP_ORDER.length) {
            hasStarted = false;
            currentStepIndex = -1;
            stepStates = {};
        }
        if (!hasStarted) initPlan();
        advanceToStep('understand');

        var responseDiv = null;
        var responseText = '';
        var sawToolAfterText = false;
        var finished = false; // guard: finishAgent runs only once
        var url = '/api/sessions/' + currentSessionId + '/agent/' + agentName;
        var idleTimer = null;

        function newBubble() {
            responseDiv = appendMessage('agent', '');
            responseText = '';
        }

        function doFinish() {
            if (finished) return;
            finished = true;
            if (idleTimer) clearTimeout(idleTimer);
            // Remove empty bubble
            if (!responseText && responseDiv && responseDiv.parentNode) {
                responseDiv.parentNode.removeChild(responseDiv);
            }
            // Don't go idle — start polling to catch remaining messages
            // (the agent may still be running on the backend)
            startPolling();
        }

        function resetIdleTimer() {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(doFinish, 180000);
        }

        resetIdleTimer();

        fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ role: 'user', content: message }])
        })
        .then(function (res) {
            if (!res.ok) throw new Error('Agent responded with ' + res.status);
            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';

            function processChunk(result) {
                if (result.done) {
                    doFinish();
                    return;
                }

                resetIdleTimer();
                buffer += decoder.decode(result.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop() || '';

                lines.forEach(function (line) {
                    if (!line.startsWith('data: ')) return;
                    try {
                        var event = JSON.parse(line.substring(6));
                        handleSSEEvent(event);

                        if (event.type === 'tool_call' || event.type === 'tool_call_response') {
                            sawToolAfterText = true;
                        }

                        if (event.type === 'agent_choice' && event.content) {
                            if (sawToolAfterText || !responseDiv) {
                                if (responseDiv && !responseText && responseDiv.parentNode) {
                                    responseDiv.parentNode.removeChild(responseDiv);
                                }
                                newBubble();
                                sawToolAfterText = false;
                            }
                            responseText += event.content;
                            renderTextContent(responseDiv, responseText);
                        }

                        // NOTE: Do NOT call finishAgent on stream_stopped — cagent emits
                        // stream_stopped after each sub-agent, not just at the end.
                        // We rely on result.done (HTTP stream EOF) instead.
                    } catch (e) {}
                });
                return reader.read().then(processChunk);
            }
            return reader.read().then(processChunk);
        })
        .catch(function (err) {
            doFinish();
        });
    }

    function handleSSEEvent(event) {
        switch (event.type) {
            case 'session_title':
                if (event.title) {
                    titleDisplay.textContent = event.title;
                    loadSessions();
                }
                break;
            case 'tool_call':
                var fn = event.tool_call && event.tool_call.function;
                if (fn) {
                    updatePlanFromTool(fn.name, fn.arguments);
                    trackFileFromTool(fn.name, fn.arguments);
                    appendToolMessage(fn.name, fn.arguments);
                }
                break;
            case 'partial_tool_call':
                var ptFn = event.tool_call && event.tool_call.function;
                if (ptFn && ptFn.name) {
                    setAgentStatus('tool', formatToolName(ptFn.name, ptFn.arguments));
                }
                break;
            case 'error':
                if (event.error) {
                    var errMsg = event.error;
                    if (errMsg.indexOf('429') !== -1 || errMsg.indexOf('quota') !== -1 || errMsg.indexOf('rate') !== -1) {
                        appendSystemMessage('Rate limit exceeded. Please wait and try again later.');
                    } else {
                        appendSystemMessage('Agent error: ' + errMsg.substring(0, 200));
                    }
                }
                break;
            case 'stream_started':
                setAgentStatus('working');
                break;
            case 'stream_stopped':
                // Don't set idle here — cagent emits stream_stopped after each
                // sub-agent, not just at the end. finishAgent handles the final idle.
                break;
        }
    }

    // finishAgent logic is now handled by stopPolling() + inline code in poll handler

    function deployChanges() {
        if (!hasWorkdir) return;
        deployBtn.disabled = true;
        deployBtn.textContent = 'Deploying...';

        fetch('/diff-api/deploy', {
            method: 'POST',
            credentials: 'same-origin'
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.ok) {
                appendSystemMessage('Changes deployed successfully.');
                deployBtn.style.display = 'none';
                discardBtn.style.display = 'none';
                reviewBtn.style.display = 'none';
                commitBtn.style.display = 'none';
                hasWorkdir = false;
                isCommitted = false;
                completePlan();
            } else {
                appendSystemMessage('Deploy failed: ' + (data.error || 'unknown error'));
            }
            deployBtn.disabled = false;
            deployBtn.textContent = 'Deploy Changes';
        })
        .catch(function () {
            appendSystemMessage('Deploy failed: could not reach diff API');
            deployBtn.disabled = false;
            deployBtn.textContent = 'Deploy Changes';
        });
    }

    function discardChanges() {
        if (!confirm('Reset all changes? The session folder will be kept.')) return;
        discardBtn.disabled = true;
        discardBtn.textContent = 'Resetting...';

        fetch('/diff-api/discard', {
            method: 'POST',
            credentials: 'same-origin'
        })
        .then(function (r) { return r.json(); })
        .then(function () {
            // Worktree is kept (only changes are reset)
            isCommitted = false;
            trackedFiles = new Set();
            diffData = [];
            deployBtn.style.display = 'none';
            commitBtn.style.display = 'none';
            // Keep discard and review visible since worktree still exists
            appendSystemMessage('Changes reset. You can continue working.');
            updateFilesPanel();
            discardBtn.disabled = false;
            discardBtn.textContent = 'Discard';
        })
        .catch(function () {
            appendSystemMessage('Reset failed: could not reach diff API');
            discardBtn.disabled = false;
            discardBtn.textContent = 'Discard';
        });
    }

    // --- Plan Tracker ---

    function initPlan() {
        hasStarted = true;
        currentStepIndex = -1;
        STEPS.forEach(function (s) { stepStates[s.id] = 'pending'; });
        renderPlan();
    }

    function advanceToStep(stepId) {
        if (!hasStarted) initPlan();
        var idx = STEP_ORDER.indexOf(stepId);
        if (idx < 0) return;
        // Only advance forward, never backward
        if (idx <= currentStepIndex) return;
        currentStepIndex = idx;
        STEPS.forEach(function (s, i) {
            if (i < idx) {
                stepStates[s.id] = 'completed';
            } else if (i === idx) {
                stepStates[s.id] = 'active';
            } else {
                stepStates[s.id] = 'pending';
            }
        });
        renderPlan();
    }

    function getStepForTool(toolName, toolArgs) {
        if (toolName === 'transfer_task') {
            try {
                var args = JSON.parse(toolArgs || '{}');
                var target = args.agent || args.target || '';
                if (target === 'analyzer') return 'analyze';
                if (target === 'implementer') return 'implement';
                if (target === 'verifier') return 'verify';
            } catch (e) {}
            return null;
        }
        if (toolName === 'shell') {
            try {
                var args = JSON.parse(toolArgs || '{}');
                var cmd = args.command || args.cmd || '';
            } catch (e) {}
            return null;
        }
        return null;
    }

    function updatePlanFromTool(toolName, toolArgs) {
        if (!hasStarted) initPlan();
        var stepId = getStepForTool(toolName, toolArgs);
        if (!stepId) return;
        advanceToStep(stepId);
    }

    function completePlan() {
        if (!hasStarted) return;
        currentStepIndex = STEP_ORDER.length;
        STEPS.forEach(function (s) { stepStates[s.id] = 'completed'; });
        renderPlan();
    }

    function reconstructPlanFromHistory(tools) {
        hasStarted = true;
        // Determine highest step reached from actual tool calls
        var maxIdx = 0;
        tools.forEach(function (t) {
            var stepId = getStepForTool(t.name, t.args);
            if (stepId) {
                var idx = STEP_ORDER.indexOf(stepId);
                if (idx > maxIdx) maxIdx = idx;
            }
        });
        currentStepIndex = maxIdx;
        // Mark steps up to maxIdx as completed, rest as pending
        STEPS.forEach(function (s, i) {
            stepStates[s.id] = (i <= maxIdx) ? 'completed' : 'pending';
        });
        renderPlan();
    }

    function renderPlan() {
        planTracker.textContent = '';

        if (!hasStarted) {
            var p = document.createElement('p');
            p.className = 'muted';
            p.textContent = 'No activity yet.';
            planTracker.appendChild(p);
            return;
        }

        STEPS.forEach(function (step) {
            var div = document.createElement('div');
            div.className = 'plan-step';
            var state = stepStates[step.id] || 'pending';
            div.classList.add(state);

            var icon = document.createElement('span');
            icon.className = 'step-icon';
            if (state === 'completed') {
                icon.textContent = '\u2713';
                icon.classList.add('check');
            } else if (state === 'active') {
                icon.classList.add('spinner');
            } else {
                icon.textContent = '\u25CB';
            }

            var label = document.createElement('span');
            label.className = 'step-label';
            label.textContent = step.label;

            div.appendChild(icon);
            div.appendChild(label);
            planTracker.appendChild(div);
        });
    }

    function setAgentStatus(status, detail) {
        statusDot.className = 'status-dot ' + status;
        if (status === 'working') {
            statusText.textContent = 'Working...';
        } else if (status === 'tool') {
            statusText.textContent = detail || 'Working...';
        } else {
            statusText.textContent = 'Idle';
        }
    }

    // --- File Tracking ---

    function trackFileFromTool(toolName, argsStr) {
        if (['write_file', 'edit_file', 'create_directory'].indexOf(toolName) === -1) return;
        try {
            var args = JSON.parse(argsStr);
            if (args.path) trackedFiles.add(args.path);
        } catch (e) {}
    }

    // Sub-agent write_file calls are invisible in root SSE.
    // Parse file paths from agent text to detect changes.
    function trackFilesFromText(text) {
        if (!text) return;
        var patterns = [
            /\/app\/workdir\/[^\s'"`,)}\]]+/g,
            /Modified files?:\s*([\s\S]*?)(?:\n\n|\n[A-Z]|$)/i
        ];
        var matches = text.match(patterns[0]);
        if (matches) {
            matches.forEach(function (m) {
                trackedFiles.add(m.trim());
            });
        }
    }

    function formatPath(path) {
        return path
            .replace(/^\/app\/workdir\/frontend\//, '')
            .replace(/^\/app\/workdir\//, '')
            .replace(/^\/app\/src\/frontend\//, '');
    }

    function fetchDiffs() {
        fetch('/diff-api/diff-all', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            diffData = data || [];
            diffData.forEach(function (d) { trackedFiles.add(d.file); });
            updateFilesPanel();
        })
        .catch(function () {
            updateFilesPanel();
        });
    }

    function diffStats(diffText) {
        var added = 0, removed = 0;
        if (!diffText) return { added: 0, removed: 0 };
        diffText.split('\n').forEach(function (line) {
            if (line.charAt(0) === '+' && !line.startsWith('+++')) added++;
            else if (line.charAt(0) === '-' && !line.startsWith('---')) removed++;
        });
        return { added: added, removed: removed };
    }

    function renderDiffBlock(diffText) {
        var container = document.createElement('div');
        container.className = 'file-diff';
        if (!diffText) return container;
        var lines = diffText.split('\n');
        lines.forEach(function (line) {
            var div = document.createElement('div');
            div.className = 'diff-line';
            div.textContent = line;
            if (line.startsWith('@@')) {
                div.classList.add('hunk');
            } else if (line.startsWith('+++') || line.startsWith('---')) {
                div.classList.add('meta');
            } else if (line.charAt(0) === '+') {
                div.classList.add('add');
            } else if (line.charAt(0) === '-') {
                div.classList.add('del');
            }
            container.appendChild(div);
        });
        return container;
    }

    function updateFilesPanel() {
        filesChanged.textContent = '';

        if (trackedFiles.size === 0 && diffData.length === 0) {
            var p = document.createElement('p');
            p.className = 'muted';
            p.textContent = 'None';
            filesChanged.appendChild(p);
            return;
        }

        var fileEntries = [];
        var seen = new Set();

        diffData.forEach(function (d) {
            seen.add(d.file);
            fileEntries.push({ name: d.file, status: d.status, diff: d.diff });
        });

        trackedFiles.forEach(function (f) {
            var short = formatPath(f);
            if (short && !seen.has(short) && !seen.has(f)) {
                fileEntries.push({ name: short, status: 'modified', diff: '' });
            }
        });

        fileEntries.forEach(function (entry) {
            var item = document.createElement('div');
            item.className = 'file-item';

            var header = document.createElement('div');
            header.className = 'file-item-header';

            var name = document.createElement('span');
            name.className = 'file-name';
            name.textContent = entry.name;

            header.appendChild(name);

            var badge = document.createElement('span');
            badge.className = 'file-badge ' + entry.status;
            badge.textContent = entry.status === 'added' ? 'A' : entry.status === 'deleted' ? 'D' : 'M';
            header.appendChild(badge);

            if (entry.diff) {
                var stats = diffStats(entry.diff);
                var statsSpan = document.createElement('span');
                statsSpan.className = 'file-stats';
                var addSpan = document.createElement('span');
                addSpan.className = 'stat-add';
                addSpan.textContent = '+' + stats.added;
                var delSpan = document.createElement('span');
                delSpan.className = 'stat-del';
                delSpan.textContent = ' -' + stats.removed;
                statsSpan.appendChild(addSpan);
                statsSpan.appendChild(delSpan);
                header.appendChild(statsSpan);
            }

            item.appendChild(header);

            (function (e) {
                header.addEventListener('click', function () {
                    openDiffModal(e.name, e.diff || '');
                });
            })(entry);

            filesChanged.appendChild(item);
        });
    }

    // --- Side-by-side diff modal ---

    function openDiffModal(fileName, diffText) {
        diffModalTitle.textContent = fileName;
        diffModalBody.textContent = '';

        if (!diffText) {
            var p = document.createElement('p');
            p.className = 'muted';
            p.style.padding = '2rem';
            p.textContent = 'No diff available for this file.';
            diffModalBody.appendChild(p);
        } else {
            diffModalBody.appendChild(buildSideBySideTable(diffText));
        }

        diffModal.style.display = 'flex';
    }

    function closeDiffModal() {
        diffModal.style.display = 'none';
        diffModalBody.textContent = '';
    }

    function buildSideBySideTable(diffText) {
        var lines = diffText.split('\n');
        var rows = []; // { type, leftNum, leftText, rightNum, rightText }
        var leftNum = 0, rightNum = 0;
        var delBuffer = [], addBuffer = [];

        function flushBuffers() {
            // Pair up del/add lines as modifications, remainder as pure del or add
            var pairs = Math.min(delBuffer.length, addBuffer.length);
            for (var i = 0; i < pairs; i++) {
                rows.push({ type: 'mod', leftNum: delBuffer[i].num, leftText: delBuffer[i].text,
                    rightNum: addBuffer[i].num, rightText: addBuffer[i].text });
            }
            for (var j = pairs; j < delBuffer.length; j++) {
                rows.push({ type: 'del', leftNum: delBuffer[j].num, leftText: delBuffer[j].text,
                    rightNum: '', rightText: '' });
            }
            for (var k = pairs; k < addBuffer.length; k++) {
                rows.push({ type: 'add', leftNum: '', leftText: '',
                    rightNum: addBuffer[k].num, rightText: addBuffer[k].text });
            }
            delBuffer = [];
            addBuffer = [];
        }

        lines.forEach(function (line) {
            // Skip diff meta headers (---, +++)
            if (line.startsWith('---') || line.startsWith('+++')) return;

            // Hunk header
            var hunkMatch = line.match(/^@@\s+-(\d+)/);
            if (hunkMatch) {
                flushBuffers();
                var hunkInfo = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/);
                if (hunkInfo) {
                    leftNum = parseInt(hunkInfo[1], 10) - 1;
                    rightNum = parseInt(hunkInfo[2], 10) - 1;
                }
                rows.push({ type: 'hunk', text: line });
                return;
            }

            if (line.startsWith('-')) {
                leftNum++;
                delBuffer.push({ num: leftNum, text: line.substring(1) });
            } else if (line.startsWith('+')) {
                rightNum++;
                addBuffer.push({ num: rightNum, text: line.substring(1) });
            } else {
                flushBuffers();
                leftNum++;
                rightNum++;
                var ctx = line.startsWith(' ') ? line.substring(1) : line;
                rows.push({ type: 'ctx', leftNum: leftNum, leftText: ctx, rightNum: rightNum, rightText: ctx });
            }
        });
        flushBuffers();

        // Build table
        var table = document.createElement('table');
        table.className = 'diff-sbs-table';

        var colgroup = document.createElement('colgroup');
        var cols = ['line-num', 'content', '', 'line-num', 'content'];
        cols.forEach(function (cls, i) {
            var col = document.createElement('col');
            if (i === 2) { col.style.width = '1px'; }
            else if (cls === 'line-num') { col.className = 'line-num'; col.style.width = '3rem'; }
            else { col.className = 'content'; }
            colgroup.appendChild(col);
        });
        table.appendChild(colgroup);

        var tbody = document.createElement('tbody');

        rows.forEach(function (row) {
            var tr = document.createElement('tr');

            if (row.type === 'hunk') {
                tr.className = 'sbs-hunk';
                var td = document.createElement('td');
                td.colSpan = 5;
                td.textContent = row.text;
                tr.appendChild(td);
            } else {
                tr.className = 'sbs-' + row.type;

                var tdLN = document.createElement('td');
                tdLN.className = 'line-num-cell left-num';
                tdLN.textContent = row.leftNum || '';
                tr.appendChild(tdLN);

                var tdLC = document.createElement('td');
                tdLC.className = 'left-content';
                tdLC.textContent = row.leftText || '';
                tr.appendChild(tdLC);

                var tdG = document.createElement('td');
                tdG.className = 'gutter';
                tr.appendChild(tdG);

                var tdRN = document.createElement('td');
                tdRN.className = 'line-num-cell right-num';
                tdRN.textContent = row.rightNum || '';
                tr.appendChild(tdRN);

                var tdRC = document.createElement('td');
                tdRC.className = 'right-content';
                tdRC.textContent = row.rightText || '';
                tr.appendChild(tdRC);
            }

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        return table;
    }

    function checkCommitStatus() {
        fetch('/diff-api/status', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            isCommitted = data.committed;
            if (isCommitted) {
                commitBtn.style.display = 'none';
                deployBtn.style.display = 'block';
            } else {
                commitBtn.style.display = 'block';
                deployBtn.style.display = 'none';
            }
        })
        .catch(function () {
            // Diff API unavailable, show commit button by default
            commitBtn.style.display = 'block';
            deployBtn.style.display = 'none';
        });
    }

    function commitChanges() {
        if (!hasWorkdir) return;
        commitBtn.disabled = true;
        commitBtn.textContent = 'Committing...';

        var commitMsg = (titleDisplay.textContent || 'Dev agent changes').replace(/^Untitled Session$/, 'Dev agent changes');

        fetch('/diff-api/commit', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: commitMsg })
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.ok) {
                isCommitted = true;
                appendSystemMessage('Changes committed: ' + commitMsg);
                commitBtn.style.display = 'none';
                deployBtn.style.display = 'block';
                fetchDiffs(); // refresh diffs so file click still works
            } else {
                appendSystemMessage('Commit failed: ' + (data.error || 'unknown error'));
            }
            commitBtn.disabled = false;
            commitBtn.textContent = 'Commit All Files';
        })
        .catch(function () {
            appendSystemMessage('Commit failed: could not reach diff API');
            commitBtn.disabled = false;
            commitBtn.textContent = 'Commit All Files';
        });
    }

    function reviewChanges() {
        if (!currentSessionId || isAgentWorking) return;
        var msg = 'Review the changes between /app/src/frontend and /app/workdir/frontend. Run diff -u on each changed file. Provide a code review: check for bugs, accessibility issues, style consistency, and suggest improvements.';
        appendMessage('user', 'Review my changes');
        sendToAgent(msg);
    }

    function resetProgressPanel() {
        setAgentStatus('idle');
        hasStarted = false;
        currentStepIndex = -1;
        stepStates = {};
        trackedFiles = new Set();
        diffData = [];
        hasWorkdir = false;
        isCommitted = false;
        deployBtn.style.display = 'none';
        discardBtn.style.display = 'none';
        reviewBtn.style.display = 'none';
        commitBtn.style.display = 'none';

        planTracker.textContent = '';
        var p1 = document.createElement('p');
        p1.className = 'muted';
        p1.textContent = 'No activity yet.';
        planTracker.appendChild(p1);

        filesChanged.textContent = '';
        var p2 = document.createElement('p');
        p2.className = 'muted';
        p2.textContent = 'None';
        filesChanged.appendChild(p2);
    }
});
