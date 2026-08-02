export function memoryRoute(tenantId, collection, memoryId) {
	const tenant = encodeURIComponent(tenantId.trim());
	const base = `/${tenant}/${collection}`;
	return memoryId ? `${base}/${encodeURIComponent(memoryId)}` : base;
}

export function filterMemories(memories, filters) {
	const query = filters.query.trim().toLocaleLowerCase();
	return memories.filter((memory) => {
		const haystack = [memory.content, memory.category, memory.layer, ...(memory.tags ?? [])]
			.join(" ")
			.toLocaleLowerCase();
		return (
			(!query || haystack.includes(query)) &&
			(!filters.category || memory.category === filters.category) &&
			(!filters.layer || memory.layer === filters.layer)
		);
	});
}

export function requiresDeleteConfirmation(memoryId, confirmation) {
	return Boolean(memoryId) && confirmation === memoryId;
}

export function tenantOptionLabel(tenant) {
	return `${tenant.id} — ${tenant.memoryCount} ${tenant.memoryCount === 1 ? "memory" : "memories"}`;
}

export function tenantPickerSummary(count) {
	return `${count} known tenant${count === 1 ? "" : "s"}`;
}

export function selectedTenantId(selectedId, manualId) {
	return manualId.trim() || selectedId.trim();
}

if (typeof document !== "undefined") {
	const state = {
		tenantId: "",
		index: null,
		memories: [],
		selectedId: null,
		pendingDeleteId: null,
		loadId: 0,
	};

	const elements = {
		tenantForm: document.querySelector("#tenant-form"),
		tenantSelect: document.querySelector("#tenant-select"),
		tenantId: document.querySelector("#tenant-id"),
		tenantSummary: document.querySelector("#tenant-summary"),
		tenantRefresh: document.querySelector("#tenant-refresh"),
		status: document.querySelector("#console-status"),
		editorPanel: document.querySelector("#editor-panel"),
		editorTitle: document.querySelector("#editor-title"),
		editorNotice: document.querySelector("#editor-notice"),
		memoryForm: document.querySelector("#memory-form"),
		memoryContent: document.querySelector("#memory-content"),
		memoryCategory: document.querySelector("#memory-category"),
		memoryLayer: document.querySelector("#memory-layer"),
		memoryTags: document.querySelector("#memory-tags"),
		cancelEdit: document.querySelector("#cancel-edit"),
		newMemory: document.querySelector("#new-memory"),
		activeTenant: document.querySelector("#active-tenant"),
		filters: document.querySelector("#filters"),
		filterQuery: document.querySelector("#filter-query"),
		filterCategory: document.querySelector("#filter-category"),
		filterLayer: document.querySelector("#filter-layer"),
		memoryCount: document.querySelector("#memory-count"),
		indexSummary: document.querySelector("#index-summary"),
		memoryList: document.querySelector("#memory-list"),
		deleteDialog: document.querySelector("#delete-dialog"),
		deleteDescription: document.querySelector("#delete-description"),
		deleteConfirmation: document.querySelector("#delete-confirmation"),
		confirmDelete: document.querySelector("#confirm-delete"),
		cancelDelete: document.querySelector("#cancel-delete"),
	};

	function setStatus(message, kind = "") {
		elements.status.textContent = message;
		if (kind) elements.status.dataset.state = kind;
		else delete elements.status.dataset.state;
	}

	function setTenantPickerBusy(busy) {
		elements.tenantSelect.setAttribute("aria-busy", String(busy));
		elements.tenantRefresh.disabled = busy;
	}

	function setSelectOptions(select, values, label) {
		select.replaceChildren();
		const allOption = document.createElement("option");
		allOption.value = "";
		allOption.textContent = `All ${label}`;
		select.append(allOption);
		for (const value of values) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value;
			select.append(option);
		}
	}

	function clearTenantState() {
		state.loadId += 1;
		state.tenantId = "";
		state.index = null;
		state.memories = [];
		state.selectedId = null;
		state.pendingDeleteId = null;
		elements.activeTenant.textContent = "No tenant selected";
		elements.filters.hidden = true;
		elements.newMemory.disabled = true;
		elements.memoryCount.textContent = "Load a tenant to begin.";
		elements.indexSummary.textContent = "";
		elements.memoryList.replaceChildren(emptyState("No records are loaded."));
		closeEditor();
		closeDeleteDialog();
	}

	function emptyState(message) {
		const empty = document.createElement("p");
		empty.className = "empty-state";
		empty.textContent = message;
		return empty;
	}

	async function request(route, options = {}) {
		const response = await fetch(route, {
			credentials: "same-origin",
			...options,
			headers: {
				...(options.body ? { "Content-Type": "application/json" } : {}),
				...(options.headers ?? {}),
			},
		});
		let payload = null;
		try {
			payload = await response.json();
		} catch {
			// A non-JSON response is handled as a generic failed operation below.
		}
		if (!response.ok || payload?.success === false || !payload) throw new Error("Request failed");
		return payload;
	}

	async function loadTenantOptions() {
		const selectedTenant = state.tenantId || elements.tenantSelect.value;
		setTenantPickerBusy(true);
		try {
			const payload = await request("/tenants");
			const tenants = Array.isArray(payload.tenants) ? payload.tenants : [];
			elements.tenantSelect.replaceChildren();
			const placeholder = document.createElement("option");
			placeholder.value = "";
			placeholder.textContent = tenants.length
				? "Select a tenant to load it…"
				: "No known tenants are available";
			elements.tenantSelect.append(placeholder);
			for (const tenant of tenants) {
				const option = document.createElement("option");
				option.value = tenant.id;
			option.textContent = tenantOptionLabel(tenant);
			elements.tenantSelect.append(option);
			}
			if (tenants.some((tenant) => tenant.id === selectedTenant)) {
				elements.tenantSelect.value = selectedTenant;
			}
			elements.tenantSelect.disabled = tenants.length === 0;
			elements.tenantSummary.textContent = tenantPickerSummary(tenants.length);
			if (tenants.length === 0) {
				setStatus("No known tenants were found. Enter a tenant ID manually.", "error");
			}
		} catch {
			elements.tenantSelect.replaceChildren();
			const unavailable = document.createElement("option");
			unavailable.value = "";
			unavailable.textContent = "Tenant choices unavailable";
			elements.tenantSelect.append(unavailable);
			elements.tenantSelect.disabled = true;
			elements.tenantSummary.textContent = "Tenant list unavailable";
			setStatus("Unable to load tenant choices. Enter a tenant ID manually.", "error");
		} finally {
			setTenantPickerBusy(false);
		}
	}

	function populateFilters() {
		const categories = [...new Set(state.memories.map((memory) => memory.category).filter(Boolean))].sort();
		const layers = [...new Set(state.memories.map((memory) => memory.layer).filter(Boolean))].sort();
		setSelectOptions(elements.filterCategory, categories, "categories");
		setSelectOptions(elements.filterLayer, layers, "layers");
	}

	function renderMemories() {
		const memories = filterMemories(state.memories, {
			query: elements.filterQuery.value,
			category: elements.filterCategory.value,
			layer: elements.filterLayer.value,
		});
		elements.memoryCount.textContent = `${memories.length} of ${state.memories.length} loaded record${state.memories.length === 1 ? "" : "s"}`;
		elements.memoryList.replaceChildren();

		if (memories.length === 0) {
			elements.memoryList.append(emptyState("No loaded records match the current filters."));
			return;
		}

		for (const memory of memories) {
			const card = document.createElement("article");
			card.className = "memory-card";
			const header = document.createElement("header");
			const id = document.createElement("code");
			id.className = "memory-id";
			id.textContent = memory.id;
			const layer = document.createElement("span");
			layer.className = "tag";
			layer.textContent = memory.layer || "current";
			header.append(id, layer);

			const content = document.createElement("p");
			content.className = "memory-content";
			content.textContent = memory.content;
			const metadata = document.createElement("div");
			metadata.className = "memory-meta";
			for (const value of [memory.category, ...(Array.isArray(memory.tags) ? memory.tags : [])].filter(Boolean)) {
				const tag = document.createElement("span");
				tag.className = "tag";
				tag.textContent = value;
				metadata.append(tag);
			}

			const actions = document.createElement("div");
			actions.className = "memory-actions";
			const edit = document.createElement("button");
			edit.className = "secondary-button";
			edit.type = "button";
			edit.textContent = "Edit content";
			edit.addEventListener("click", () => openEditor(memory));
			const remove = document.createElement("button");
			remove.className = "danger-button";
			remove.type = "button";
			remove.textContent = "Delete";
			remove.addEventListener("click", () => openDeleteDialog(memory));
			actions.append(edit, remove);
			card.append(header, content, metadata, actions);
			elements.memoryList.append(card);
		}
	}

	async function loadWorkspace(rawTenantId) {
		const tenantId = rawTenantId.trim();
		if (!tenantId) return;
		clearTenantState();
		state.tenantId = tenantId;
		const loadId = state.loadId;
		elements.tenantSelect.value = tenantId;
		setTenantPickerBusy(true);
		setStatus("Loading MCP memory workspace…");

		try {
			const workspace = await request(memoryRoute(tenantId, "workspace"));
			if (loadId !== state.loadId || state.tenantId !== tenantId) return;
			state.index = workspace.index ?? null;
			state.memories = Array.isArray(workspace.memories) ? workspace.memories : [];
			elements.activeTenant.textContent = tenantId;
			elements.filters.hidden = false;
			elements.newMemory.disabled = false;
			elements.indexSummary.textContent = state.index ? "Tenant index loaded" : "";
			populateFilters();
			renderMemories();
			setStatus("MCP workspace loaded.", "success");
		} catch {
			if (loadId !== state.loadId || state.tenantId !== tenantId) return;
			clearTenantState();
			setStatus("Unable to load that tenant workspace. Your current records remain unchanged.", "error");
		} finally {
			const completedCurrentLoad = state.loadId === loadId && state.tenantId === tenantId;
			const completedCurrentFailure = state.loadId === loadId + 1 && !state.tenantId;
			if (completedCurrentLoad || completedCurrentFailure) setTenantPickerBusy(false);
		}
	}

	function openEditor(memory = null) {
		if (!state.tenantId) return;
		state.selectedId = memory?.id ?? null;
		elements.editorPanel.hidden = false;
		elements.editorTitle.textContent = memory ? "Edit memory content" : "New memory";
		elements.memoryContent.value = memory?.content ?? "";
		elements.memoryCategory.value = memory?.category ?? "knowledge";
		elements.memoryLayer.value = memory?.layer ?? "current";
		elements.memoryTags.value = Array.isArray(memory?.tags) ? memory.tags.join(", ") : "";
		const editing = Boolean(memory);
		elements.memoryCategory.disabled = editing;
		elements.memoryLayer.disabled = editing;
		elements.memoryTags.disabled = editing;
		elements.editorNotice.hidden = !editing;
		if (editing) elements.editorNotice.textContent = "The current update API changes memory content only. Category, layer, and tags are retained.";
		elements.memoryContent.focus();
	}

	function closeEditor() {
		state.selectedId = null;
		elements.editorPanel.hidden = true;
		elements.memoryForm.reset();
		elements.memoryCategory.value = "knowledge";
		elements.memoryLayer.value = "current";
		elements.memoryCategory.disabled = false;
		elements.memoryLayer.disabled = false;
		elements.memoryTags.disabled = false;
		elements.editorNotice.hidden = true;
	}

	function openDeleteDialog(memory) {
		state.pendingDeleteId = memory.id;
		elements.deleteDescription.textContent = `This permanently removes ${memory.id} from the loaded tenant.`;
		elements.deleteConfirmation.value = "";
		elements.confirmDelete.disabled = true;
		if (typeof elements.deleteDialog.showModal === "function") elements.deleteDialog.showModal();
		else elements.deleteDialog.setAttribute("open", "");
		elements.deleteConfirmation.focus();
	}

	function closeDeleteDialog() {
		state.pendingDeleteId = null;
		elements.deleteConfirmation.value = "";
		elements.confirmDelete.disabled = true;
		if (typeof elements.deleteDialog.close === "function" && elements.deleteDialog.open) elements.deleteDialog.close();
		else elements.deleteDialog.removeAttribute("open");
	}

	elements.tenantForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const tenantId = selectedTenantId(elements.tenantSelect.value, elements.tenantId.value);
		if (!tenantId) {
			setStatus("Select a tenant or enter a tenant ID manually.", "error");
			return;
		}
		void loadWorkspace(tenantId);
	});

	elements.tenantSelect.addEventListener("change", () => {
		const tenantId = elements.tenantSelect.value.trim();
		if (!tenantId) return;
		elements.tenantId.value = "";
		void loadWorkspace(tenantId);
	});

	elements.tenantRefresh.addEventListener("click", () => void loadTenantOptions());

	elements.newMemory.addEventListener("click", () => openEditor());
	elements.cancelEdit.addEventListener("click", closeEditor);
	for (const filter of [elements.filterQuery, elements.filterCategory, elements.filterLayer]) {
		filter.addEventListener("input", renderMemories);
		filter.addEventListener("change", renderMemories);
	}

	elements.memoryForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const tenantId = state.tenantId;
		const content = elements.memoryContent.value.trim();
		if (!tenantId || !content) return;
		const memoryId = state.selectedId;
		const body = memoryId
			? { content }
			: {
					content,
					category: elements.memoryCategory.value.trim() || "knowledge",
					layer: elements.memoryLayer.value.trim() || "current",
					tags: elements.memoryTags.value.split(",").map((tag) => tag.trim()).filter(Boolean),
				};
		setStatus(memoryId ? "Saving memory content…" : "Creating memory…");
		void request(memoryRoute(tenantId, "memories", memoryId ?? undefined), {
			method: memoryId ? "PUT" : "POST",
			body: JSON.stringify(body),
		})
			.then(async () => {
				setStatus(memoryId ? "Memory updated." : "Memory created.", "success");
				await loadWorkspace(tenantId);
			})
			.catch(() => setStatus("Unable to save the memory. The loaded records remain unchanged.", "error"));
	});

	elements.deleteConfirmation.addEventListener("input", () => {
		elements.confirmDelete.disabled = !requiresDeleteConfirmation(
			state.pendingDeleteId,
			elements.deleteConfirmation.value,
		);
	});

	elements.confirmDelete.addEventListener("click", () => {
		const memoryId = state.pendingDeleteId;
		const tenantId = state.tenantId;
		if (!requiresDeleteConfirmation(memoryId, elements.deleteConfirmation.value) || !tenantId) return;
		elements.confirmDelete.disabled = true;
		setStatus("Deleting memory…");
		void request(memoryRoute(tenantId, "memories", memoryId), { method: "DELETE" })
			.then(async () => {
				closeDeleteDialog();
				setStatus("Memory deleted.", "success");
				await loadWorkspace(tenantId);
			})
			.catch(() => {
				elements.confirmDelete.disabled = !requiresDeleteConfirmation(memoryId, elements.deleteConfirmation.value);
				setStatus("Unable to delete the memory. The loaded records remain unchanged.", "error");
			});
	});

	elements.cancelDelete.addEventListener("click", closeDeleteDialog);
	elements.deleteDialog.addEventListener("cancel", closeDeleteDialog);
	void loadTenantOptions();
}
