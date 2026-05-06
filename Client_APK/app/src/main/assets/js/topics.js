/**
 * procMessenger Mobile - Topics Management
 *
 * Topic CRUD operations: create, edit, select, sync.
 */

// Module-level state for the topics modal (not shared globally via state.js)
let editingTopicId = null;  // null = creating new, string = editing existing

function openTopicModal(topicToEdit) {
    const modal = document.getElementById("topicModal");
    const title = document.getElementById("topicModalTitle");
    const nameInput = document.getElementById("topicNameInput");
    const infoInput = document.getElementById("topicInfoInput");
    if (!modal) return;

    if (topicToEdit) {
        editingTopicId = topicToEdit.id;
        if (title) title.textContent = "Edit Topic";
        if (nameInput) nameInput.value = topicToEdit.name || "";
        if (infoInput) infoInput.value = topicToEdit.info || "";
    } else {
        editingTopicId = null;
        if (title) title.textContent = "Create New Topic";
        if (nameInput) nameInput.value = "";
        if (infoInput) infoInput.value = "";
    }

    modal.classList.add("visible");
}

function closeTopicModal() {
    const modal = document.getElementById("topicModal");
    if (modal) modal.classList.remove("visible");
    editingTopicId = null;
}

function openTopicModalFromSelect(action) {
    if (action === "edit") {
        // Find the first selected topic to edit
        const selected = serverTopics.find(t => selectedTopicIds.has(t.id));
        if (!selected) {
            alert("Select a topic to edit first.");
            return;
        }
        // Close the Select Topics window first, then open Edit
        const selectModal = document.getElementById("topicSelectModal");
        if (selectModal) selectModal.classList.remove("visible");
        openTopicModal(selected);
    } else {
        // Close the Select Topics window first, then open Create New Topic
        const selectModal = document.getElementById("topicSelectModal");
        if (selectModal) selectModal.classList.remove("visible");
        openTopicModal(null);
    }
}

function saveTopic() {
    const nameInput = document.getElementById("topicNameInput");
    const infoInput = document.getElementById("topicInfoInput");
    const name = nameInput ? nameInput.value.trim() : "";
    const info = infoInput ? infoInput.value.trim() : "";

    if (!name || !info) {
        alert("Please enter both a topic name and information.");
        return;
    }

    if (wsManager && wsManager.connected) {
        if (editingTopicId) {
            wsManager.send("topic_update", "server", { id: editingTopicId, name, info });
            setStatus("connected", `Topic "${name}" updated.`);
        } else {
            wsManager.send("topic_create", "server", { name, info });
            setStatus("connected", `Topic "${name}" sent to server.`);
        }

        nameInput.value = "";
        infoInput.value = "";
        closeTopicModal();
    } else {
        setStatus("error", "Not connected to server.");
    }
}

function syncTopics() {
    if (!wsManager || !wsManager.connected) {
        setStatus("error", "Not connected to server.");
        return;
    }
    wsManager.send("topic_sync", "server", { topics: serverTopics });
    setStatus("connected", "Syncing topics...");
}

function openTopicSelectModal() {
    const modal = document.getElementById("topicSelectModal");
    if (modal) {
        modal.classList.add("visible");
        renderTopicSelectList();
    }
}

function closeTopicSelectModal() {
    const modal = document.getElementById("topicSelectModal");
    if (modal) {
        modal.classList.remove("visible");
        // Update the main panel's display of selected topics
        if (document.getElementById("functionSelect").value === "llm_chat") {
            const display = document.getElementById("topicDisplay");
            if (display) {
                const selectedTopics = serverTopics.filter(t => selectedTopicIds.has(t.id));
                const text = selectedTopics.length > 0
                    ? selectedTopics.map(t => t.name).join(", ")
                    : "Select topics...";
                display.textContent = text;
                display.title = text;
            }
        }
    }
}

function renderTopicSelectList() {
    const container = document.getElementById("topicSelectList");
    if (!container) return;
    container.innerHTML = "";

    if (serverTopics.length === 0) {
        container.innerHTML = '<div class="empty-list">No topics found on server.</div>';
        return;
    }

    serverTopics.forEach((topic) => {
        const item = document.createElement("div");
        const isSelected = selectedTopicIds.has(topic.id);
        item.className = "topic-select-item" + (isSelected ? " selected" : "");

        item.innerHTML = `
            <input type="checkbox" class="topic-select-checkbox" ${isSelected ? "checked" : ""} />
            <div class="topic-select-info">
                <div class="topic-select-name">${escapeHtml(topic.name)}</div>
                <div class="topic-select-desc">${escapeHtml(topic.info.substring(0, 60))}${topic.info.length > 60 ? "..." : ""}</div>
            </div>
        `;

        item.addEventListener("click", () => {
            // Toggle checkbox and selection
            if (selectedTopicIds.has(topic.id)) {
                selectedTopicIds.delete(topic.id);
            } else {
                selectedTopicIds.add(topic.id);
            }
            renderTopicSelectList();
        });

        container.appendChild(item);
    });
}
