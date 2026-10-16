"use strict";
(() => {
    const key = "utex-workspace-theme";
    const root = document.documentElement;
    let theme = "dark";
    try {
        const saved = localStorage.getItem(key);
        if (saved === "light" || saved === "dark") theme = saved;
    } catch (_) { /* The switch also works when browser storage is unavailable. */ }
    root.dataset.theme = theme;
    function syncButton() {
        const button = document.getElementById("theme-toggle");
        if (!button) return;
        const dark = root.dataset.theme === "dark";
        button.setAttribute("aria-pressed", String(dark));
        button.title = dark ? "Увімкнути світлу тему" : "Увімкнути темну тему";
        document.getElementById("theme-label").textContent = dark ? "Темна тема" : "Світла тема";
    }
    document.addEventListener("DOMContentLoaded", () => {
        syncButton();
        document.getElementById("theme-toggle")?.addEventListener("click", () => {
            const next = root.dataset.theme === "dark" ? "light" : "dark";
            root.dataset.theme = next;
            try { localStorage.setItem(key, next); } catch (_) {}
            syncButton();
        });
    });
    window.addEventListener("storage", (event) => {
        if (event.key === key) {
            root.dataset.theme = event.newValue === "light" ? "light" : "dark";
            syncButton();
        }
    });
})();
