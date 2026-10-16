"use strict";
document.querySelectorAll(".workspace-form").forEach((form) => {
    if (form.dataset.kind === "execution") {
        [["has_deviation", ["deviation_comment"]], ["has_downtime", ["downtime_hours", "downtime_minutes", "downtime_reason"]]].forEach(([name, fields]) => {
            const checkbox = form.elements[name];
            if (!checkbox) return;
            const update = () => fields.forEach((field) => {
                const row = form.querySelector('[data-field="' + field + '"]');
                if (row) row.hidden = !checkbox.checked;
            });
            checkbox.addEventListener("change", update);
            update();
        });
    }
    form.addEventListener("submit", () => {
        const button = form.querySelector('button[type="submit"]');
        if (button) { button.disabled = true; button.textContent = "Зберігаємо…"; }
    });
});
const schedule = document.getElementById("schedule-form");
if (schedule) schedule.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = schedule.querySelector('button[type="submit"]');
    const feedback = schedule.querySelector(".form-feedback");
    button.disabled = true;
    feedback.textContent = "";
    try {
        const response = await fetch(schedule.dataset.url, {
            method: "POST",
            headers: {"Content-Type": "application/json", "X-CSRFToken": schedule.elements.csrfmiddlewaretoken.value},
            // The server interprets a timezone-less value as the project's Europe/Kyiv timezone.
            body: JSON.stringify({id: Number(schedule.dataset.plan), group: Number(schedule.elements.group.value), start: schedule.elements.start.value})
        });
        if (!response.ok || response.redirected) throw new Error("Сесію завершено або сервер недоступний. Оновіть сторінку.");
        const result = await response.json();
        if (result.status !== "success") throw new Error(result.message || "Не вдалося зберегти розклад.");
        window.location.reload();
    } catch (error) {
        feedback.textContent = error.message || "Не вдалося з’єднатися із сервером.";
        button.disabled = false;
    }
});
