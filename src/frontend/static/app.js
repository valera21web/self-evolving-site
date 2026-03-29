document.addEventListener('DOMContentLoaded', function () {

    // === A. Dark Mode ===
    (function initTheme() {
        var toggle = document.getElementById('theme-toggle');
        var icon = toggle ? toggle.querySelector('.theme-icon') : null;

        function getPreferredTheme() {
            var stored = localStorage.getItem('theme');
            if (stored) return stored;
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                return 'dark';
            }
            return 'light';
        }

        function applyTheme(theme) {
            document.documentElement.setAttribute('data-theme', theme);
            if (icon) {
                icon.textContent = theme === 'dark' ? '\u{1F319}' : '\u{2600}\u{FE0F}';
            }
        }

        applyTheme(getPreferredTheme());

        if (toggle) {
            toggle.addEventListener('click', function () {
                var current = document.documentElement.getAttribute('data-theme');
                var next = current === 'dark' ? 'light' : 'dark';
                localStorage.setItem('theme', next);
                applyTheme(next);
            });
        }
    })();

    // === B. Empty State + C. Pagination (index page only) ===
    var newsList = document.getElementById('news-list');
    var emptyState = document.getElementById('empty-state');

    if (!newsList) return;

    var items = Array.prototype.slice.call(newsList.children);

    if (items.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    }

    // === C. Pagination ===
    var ITEMS_PER_PAGE = 10;
    var totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);

    if (totalPages <= 1) return;

    var currentPage = 1;
    var paginationDiv = document.getElementById('pagination');

    function showPage(page) {
        currentPage = page;
        var start = (page - 1) * ITEMS_PER_PAGE;
        var end = start + ITEMS_PER_PAGE;

        for (var i = 0; i < items.length; i++) {
            items[i].style.display = (i >= start && i < end) ? '' : 'none';
        }

        renderPagination();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function clearElement(el) {
        while (el.firstChild) {
            el.removeChild(el.firstChild);
        }
    }

    function createPageBtn(text, disabled, onClick) {
        var btn = document.createElement('button');
        btn.textContent = text;
        btn.className = 'page-btn';
        btn.disabled = disabled;
        if (onClick) btn.addEventListener('click', onClick);
        return btn;
    }

    function renderPagination() {
        clearElement(paginationDiv);

        paginationDiv.appendChild(
            createPageBtn('\u2190 Prev', currentPage === 1, function () { showPage(currentPage - 1); })
        );

        for (var p = 1; p <= totalPages; p++) {
            var btn = createPageBtn(String(p), false, (function (page) {
                return function () { showPage(page); };
            })(p));
            if (p === currentPage) btn.className += ' active';
            paginationDiv.appendChild(btn);
        }

        paginationDiv.appendChild(
            createPageBtn('Next \u2192', currentPage === totalPages, function () { showPage(currentPage + 1); })
        );
    }

    showPage(1);
});
