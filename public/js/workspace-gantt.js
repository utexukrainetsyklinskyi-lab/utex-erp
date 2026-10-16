"use strict";
(async () => {
    const container = document.getElementById("visualization");
    if (!container) return;
    const status = document.getElementById("gantt-status");
    const controls = ["gantt-today", "gantt-fit", "gantt-in", "gantt-out"].map(id => document.getElementById(id));
    controls.forEach(control => control.disabled = true);
    try {
        if (typeof vis === "undefined") throw new Error("Не вдалося завантажити бібліотеку графіка. Оновіть сторінку.");
        const response = await fetch(container.dataset.source);
        if (!response.ok || response.redirected) throw new Error("Не вдалося отримати розклад. Перевірте вхід у систему.");
        const data = await response.json();
        const priority = ["Фарбувальна", "SCL", "SZL", "FTTH", "К-90", "К-80"];
        data.groups.forEach(group => {
            const index = priority.findIndex(text => group.content.includes(text));
            group.order = index < 0 ? 99 : index;
        });
        const items = new vis.DataSet(data.items);
        const timeline = new vis.Timeline(container, items, new vis.DataSet(data.groups), {
            groupOrder: "order", orientation: "top", stack: true, margin: {item: 12, axis: 10},
            editable: {add: false, updateTime: true, updateGroup: true, remove: false},
            onMove: async (item, callback) => {
                if (item.editable === false) {
                    callback(null);
                    status.classList.add("error");
                    status.textContent = "Завершене завдання не можна переміщувати.";
                    return;
                }
                status.classList.remove("error");
                status.textContent = "Зберігаємо розклад…";
                try {
                    const response = await fetch(container.dataset.update, {
                        method: "POST", headers: {"Content-Type": "application/json", "X-CSRF-Token": document.querySelector("#gantt-csrf input").value},
                        body: JSON.stringify({id: item.id, group: item.group, start: item.start})
                    });
                    if (!response.ok || response.redirected) throw new Error("Сесію завершено або сервер недоступний. Оновіть сторінку.");
                    const result = await response.json();
                    if (result.status !== "success") throw new Error(result.message || "Не вдалося зберегти розклад.");
                    item.end = new Date(result.new_end);
                    callback(item);
                    status.textContent = "Розклад збережено.";
                } catch (error) {
                    callback(null);
                    status.classList.add("error");
                    status.textContent = error.message;
                }
            }
        });
        timeline.on("doubleClick", event => {
            if (event.item != null) window.location.href = container.dataset.planBase + encodeURIComponent(event.item) + "/";
        });
        controls.forEach(control => control.disabled = false);
        controls[0].addEventListener("click", () => timeline.moveTo(new Date()));
        controls[1].addEventListener("click", () => timeline.fit());
        controls[2].addEventListener("click", () => timeline.zoomIn(0.4));
        controls[3].addEventListener("click", () => timeline.zoomOut(0.4));
        status.textContent = data.items.length ? "Завдань у розкладі: " + data.items.length : "Поки немає запланованих завдань. Задайте час початку в картці завдання.";
    } catch (error) {
        status.classList.add("error");
        status.textContent = error.message;
    }
})();
