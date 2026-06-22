// app.js — UI state and DOM manipulation for LogLifted Plan Builder

"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  exercises: [],
  templates: [],
  plan: null,
};

function genId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function $(sel) {
  return document.querySelector(sel);
}

function clearError(id) {
  $(id).textContent = "";
}

function showError(id, msg) {
  $(id).textContent = msg;
}

function exerciseName(id) {
  const ex = state.exercises.find((e) => e.id === id);
  return ex ? ex.name : "(deleted)";
}

/**
 * Estimated 1RM using Brzycki formula: 1RM = W × 36 / (37 − R)
 * Returns null for bodyweight (weight <= 0) or reps >= 10
 */
function estimatedOneRM(weight, reps) {
  if (weight <= 0 || reps <= 0 || reps >= 10) return null;
  return Math.round((weight * 36) / (37 - reps));
}

/** Round weight to nearest plate increment (2.5 kg) */
function roundToPlates(weight) {
  return Math.round(weight / 2.5) * 2.5;
}

/** Get PB data for an exercise from its notes (parsed during import) */
function getExercisePB(exerciseId) {
  const ex = state.exercises.find((e) => e.id === exerciseId);
  if (!ex || !ex.notes) return null;
  const match = ex.notes.match(/PB:\s*([\d.]+)kg\s*x(\d+)/);
  if (!match) return null;
  return { weight: parseFloat(match[1]), reps: parseInt(match[2], 10) };
}

/**
 * Parse progressions from .lifted file.
 * Swift encodes [UUID: [String]] as alternating array [key, value, key, value, ...].
 * Also handles plain object format for compatibility.
 */
function parseProgressions(raw) {
  if (!raw) return {};
  // Array format (Swift): [uuid, [strings], uuid, [strings], ...]
  if (Array.isArray(raw)) {
    const result = {};
    for (let i = 0; i + 1 < raw.length; i += 2) {
      result[raw[i]] = raw[i + 1];
    }
    return result;
  }
  // Object format
  if (typeof raw === "object") return raw;
  return {};
}

/** Create a remove (×) icon button */
function createRemoveBtn(onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-icon btn-icon-danger";
  btn.textContent = "\u00D7";
  btn.title = "Remove";
  btn.addEventListener("click", onClick);
  return btn;
}

/** Get est 1RM for a template item (single exercise only) */
function itemOneRM(item) {
  if (!item.content.exercise) return null;
  const pb = getExercisePB(item.content.exercise.exerciseId);
  if (!pb) return null;
  return estimatedOneRM(pb.weight, pb.reps);
}

/** Describe a template item for display */
function itemLabel(item) {
  if (item.content.exercise) {
    return exerciseName(item.content.exercise.exerciseId);
  }
  const names = item.content.superset.exerciseIds.map(exerciseName);
  return names.join(" + ");
}

// ---------------------------------------------------------------------------
// 0. Import
// ---------------------------------------------------------------------------

function handleImportFile(file) {
  clearError("#import-error");
  $("#import-summary").hidden = true;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      importLiftedData(data);
      $("#import-filename").textContent = file.name;
    } catch (err) {
      showError("#import-error", "Failed to parse file: " + err.message);
    }
  };
  reader.readAsText(file);
}

function importLiftedData(data) {
  if (!data.exercises || !Array.isArray(data.exercises)) {
    showError("#import-error", "Invalid .lifted file: missing exercises.");
    return;
  }

  // Compute personal bests from workouts
  const personalBests = computePersonalBests(data.workouts || []);

  // Import exercises
  const exerciseMap = new Map(); // old id -> new id
  for (const ex of data.exercises) {
    const newId = ex.id || genId();
    const pb = personalBests.get(ex.id);
    let notes = ex.notes || null;
    // Append PB info to notes
    if (pb) {
      const pbText = formatPersonalBest(pb);
      notes = notes ? notes + " | PB: " + pbText : "PB: " + pbText;
    }
    state.exercises.push({
      id: newId,
      name: ex.name,
      notes: notes,
      isHidden: ex.isHidden || false,
      isDeleted: ex.isDeleted || false,
      restSeconds: ex.restSeconds ?? null,
      weightRoundingStepKg: ex.weightRoundingStepKg ?? null,
    });
    exerciseMap.set(ex.id, newId);
  }

  // Import templates (if present)
  let templatesImported = 0;
  if (data.templates && Array.isArray(data.templates)) {
    for (const tmpl of data.templates) {
      const newTmplId = tmpl.id || genId();
      const items = (tmpl.items || []).map((item) => ({
        id: item.id || genId(),
        content: remapItemContent(item.content, exerciseMap),
      }));
      state.templates.push({
        id: newTmplId,
        name: tmpl.name,
        items: items,
      });
      templatesImported++;
    }
  }

  // Import plans (if present)
  if (data.plans && Array.isArray(data.plans) && data.plans.length > 0) {
    const plan = data.plans[0];
    state.plan = {
      id: plan.id || genId(),
      name: plan.name || "",
      templateIds: plan.templateIds || [],
      isLooping: plan.isLooping || false,
      progressions: parseProgressions(plan.progressions),
      notes: plan.notes ?? null,
    };
    $("#plan-name").value = state.plan.name;
    $("#plan-notes").value = state.plan.notes ?? "";
    $("#plan-looping").checked = state.plan.isLooping;
  }

  // Re-render everything
  renderExercises();
  renderTemplates();
  refreshAllTemplateSelects();
  refreshPlanTemplateSelect();
  renderPlanTemplates();
  renderProgressions();

  // Show summary
  const hiddenCount = state.exercises.filter((e) => e.isHidden && !e.isDeleted).length;
  const deletedCount = state.exercises.filter((e) => e.isDeleted).length;
  showImportSummary(
    state.exercises.length,
    hiddenCount,
    deletedCount,
    templatesImported,
    data.workouts ? data.workouts.length : 0,
    personalBests.size
  );
}

function computePersonalBests(workouts) {
  // Map: exerciseId -> { maxWeight, repsAtMax, maxReps }
  const bests = new Map();

  for (const workout of workouts) {
    if (!workout.exercises) continue;
    for (const wex of workout.exercises) {
      if (!wex.sets) continue;
      let pb = bests.get(wex.exerciseId) || {
        maxWeight: 0,
        repsAtMax: 0,
        maxReps: 0,
      };

      for (const set of wex.sets) {
        const w = set.weight || 0;
        const r = set.reps || 0;
        if (w > pb.maxWeight) {
          pb.maxWeight = w;
          pb.repsAtMax = r;
        } else if (w === pb.maxWeight && r > pb.repsAtMax) {
          pb.repsAtMax = r;
        }
        if (r > pb.maxReps) {
          pb.maxReps = r;
        }
      }

      if (pb.maxWeight > 0 || pb.maxReps > 0) {
        bests.set(wex.exerciseId, pb);
      }
    }
  }

  return bests;
}

function formatPersonalBest(pb) {
  const parts = [];
  if (pb.maxWeight > 0) {
    parts.push(`${pb.maxWeight}kg x${pb.repsAtMax}`);
  }
  if (pb.maxReps > 0 && pb.maxWeight === 0) {
    parts.push(`${pb.maxReps} reps (BW)`);
  }
  return parts.join(", ");
}

function remapItemContent(content, exerciseMap) {
  if (content.exercise) {
    return {
      exercise: {
        exerciseId:
          exerciseMap.get(content.exercise.exerciseId) ||
          content.exercise.exerciseId,
      },
    };
  }
  if (content.superset) {
    return {
      superset: {
        exerciseIds: content.superset.exerciseIds.map(
          (id) => exerciseMap.get(id) || id
        ),
      },
    };
  }
  return content;
}

function showImportSummary(exercises, hidden, deleted, templates, workouts, withPB) {
  const summary = $("#import-summary");
  summary.hidden = false;
  summary.innerHTML = "";

  const activeCount = exercises - hidden - deleted;
  const lines = [
    { label: "Exercises loaded", value: `${activeCount} active` + (hidden ? `, ${hidden} hidden` : "") + (deleted ? `, ${deleted} deleted` : "") },
    { label: "Templates loaded", value: templates },
    { label: "Workouts analyzed", value: workouts },
    { label: "Exercises with personal bests", value: withPB },
  ];

  for (const line of lines) {
    const div = document.createElement("div");
    const labelSpan = document.createElement("span");
    labelSpan.className = "stat-label";
    labelSpan.textContent = line.label + ": ";
    const valueSpan = document.createElement("span");
    valueSpan.className = "stat-value";
    valueSpan.textContent = line.value;
    div.appendChild(labelSpan);
    div.appendChild(valueSpan);
    summary.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// 1. Exercises
// ---------------------------------------------------------------------------

function renderExercises() {
  const list = $("#exercises-list");
  list.innerHTML = "";
  if (!state.exercises.length) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "No exercises yet. Add one above.";
    list.appendChild(li);
    return;
  }

  const active = state.exercises.filter((e) => !e.isHidden && !e.isDeleted);
  const hidden = state.exercises.filter((e) => e.isHidden && !e.isDeleted);
  const deleted = state.exercises.filter((e) => e.isDeleted);

  // Active exercises
  for (const ex of active) {
    list.appendChild(buildExerciseLi(ex));
  }

  // Hidden exercises (collapsible)
  if (hidden.length) {
    list.appendChild(
      buildCollapsibleGroup("Hidden", hidden, "hidden-exercises")
    );
  }

  // Deleted exercises (collapsible)
  if (deleted.length) {
    list.appendChild(
      buildCollapsibleGroup("Deleted", deleted, "deleted-exercises")
    );
  }
}

function buildExerciseLi(ex) {
  const li = document.createElement("li");
  li.draggable = true;
  li.dataset.exerciseId = ex.id;
  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-exercise-id", ex.id);
    e.dataTransfer.effectAllowed = "copy";
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
  });

  if (ex.isHidden) li.classList.add("exercise-hidden");
  if (ex.isDeleted) li.classList.add("exercise-deleted");

  const nameSpan = document.createElement("span");
  nameSpan.className = "item-name";
  nameSpan.textContent = ex.name;
  li.appendChild(nameSpan);

  if (ex.notes) {
    const notesSpan = document.createElement("span");
    notesSpan.className = "item-notes";
    if (ex.notes.includes("PB:")) {
      const parts = ex.notes.split("PB:");
      if (parts[0].trim()) {
        notesSpan.textContent = parts[0].trim();
        li.appendChild(notesSpan);
        const pbSpan = document.createElement("span");
        pbSpan.className = "personal-best";
        pbSpan.textContent = "PB:" + parts[1];
        li.appendChild(pbSpan);
      } else {
        notesSpan.className = "personal-best";
        notesSpan.textContent = "PB:" + parts[1];
        li.appendChild(notesSpan);
      }
    } else {
      notesSpan.textContent = ex.notes;
      li.appendChild(notesSpan);
    }
  }

  // Est 1RM
  const pb = getExercisePB(ex.id);
  if (pb) {
    const oneRM = estimatedOneRM(pb.weight, pb.reps);
    if (oneRM) {
      const rmSpan = document.createElement("span");
      rmSpan.className = "est-1rm";
      rmSpan.textContent = `1RM: ${oneRM}kg`;
      li.appendChild(rmSpan);
    }
  }

  // Per-exercise weight rounding step for {N%} macro substitution (kg; null = app default).
  if (!ex.isDeleted) {
    li.appendChild(buildRoundingSelect(ex));
  }

  li.appendChild(createRemoveBtn(() => removeExercise(ex.id)));

  return li;
}

// Rounding step options (kg). "" = use the app's global default. Mirrors WeightRoundingStep.
const ROUNDING_STEP_OPTIONS = [
  { value: "", label: "Round: default" },
  { value: "1", label: "Round: 1 kg" },
  { value: "2.5", label: "Round: 2.5 kg" },
  { value: "5", label: "Round: 5 kg" },
  { value: "10", label: "Round: 10 kg" },
];

function buildRoundingSelect(ex) {
  const select = document.createElement("select");
  select.className = "rounding-select";
  select.title = "Weight rounding step for {N%} progression macros";
  for (const opt of ROUNDING_STEP_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    select.appendChild(o);
  }
  // String(2.5) === "2.5", String(5) === "5" — matches option values; unknown → "" (default).
  select.value = ex.weightRoundingStepKg == null ? "" : String(ex.weightRoundingStepKg);
  select.addEventListener("change", () => {
    ex.weightRoundingStepKg = select.value === "" ? null : parseFloat(select.value);
  });
  return select;
}

function buildCollapsibleGroup(label, exercises, id) {
  const wrapper = document.createElement("li");
  wrapper.className = "collapsible-group";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn btn-secondary collapsible-toggle";
  toggle.textContent = `${label} (${exercises.length})`;
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    inner.hidden = expanded;
  });
  wrapper.appendChild(toggle);

  const inner = document.createElement("ul");
  inner.className = "item-list collapsible-inner";
  inner.id = id;
  inner.hidden = true;
  for (const ex of exercises) {
    inner.appendChild(buildExerciseLi(ex));
  }
  wrapper.appendChild(inner);

  return wrapper;
}

function addExercise(name, notes) {
  const trimmed = name.trim();
  if (!trimmed) {
    showError("#exercise-error", "Exercise name is required.");
    return;
  }
  clearError("#exercise-error");
  state.exercises.push({
    id: genId(),
    name: trimmed,
    notes: notes.trim() || null,
    isHidden: false,
    isDeleted: false,
    restSeconds: null,
    weightRoundingStepKg: null,
  });
  renderExercises();
  refreshAllTemplateSelects();
  refreshPlanTemplateSelect();
}

function removeExercise(id) {
  state.exercises = state.exercises.filter((e) => e.id !== id);
  renderExercises();
  refreshAllTemplateSelects();
}

// ---------------------------------------------------------------------------
// 2. Templates
// ---------------------------------------------------------------------------

function renderTemplates() {
  const container = $("#templates-list");
  container.innerHTML = "";
  if (!state.templates.length) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No templates yet. Create one above.";
    container.appendChild(p);
    return;
  }
  for (const tmpl of state.templates) {
    container.appendChild(buildTemplateCard(tmpl));
  }
}

function buildTemplateCard(tmpl) {
  const card = document.createElement("div");
  card.className = "template-card";
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-template-to-plan", tmpl.id);
    e.dataTransfer.effectAllowed = "copy";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
  });

  // Header
  const header = document.createElement("div");
  header.className = "template-card-header";

  const title = document.createElement("h4");
  title.textContent = tmpl.name;
  title.title = "Double-click to rename";
  title.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-rename";
    input.value = tmpl.name;
    const commit = () => {
      const newName = input.value.trim();
      if (newName && newName !== tmpl.name) {
        tmpl.name = newName;
        renderTemplates();
        refreshPlanTemplateSelect();
        renderPlanTemplates();
        renderProgressions();
      } else {
        title.hidden = false;
        input.remove();
      }
    };
    input.addEventListener("keydown", (ke) => {
      if (ke.key === "Enter") commit();
      if (ke.key === "Escape") { title.hidden = false; input.remove(); }
    });
    input.addEventListener("blur", commit);
    title.hidden = true;
    header.insertBefore(input, title.nextSibling);
    input.focus();
    input.select();
  });
  header.appendChild(title);

  const deleteBtn = createRemoveBtn(() => removeTemplate(tmpl.id));
  deleteBtn.addEventListener("click", (e) => e.stopPropagation());
  header.appendChild(deleteBtn);
  card.appendChild(header);

  // Body (drop zone)
  const body = document.createElement("div");
  body.className = "template-card-body";
  body.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("application/x-exercise-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      body.classList.add("drop-target");
    }
  });
  body.addEventListener("dragleave", (e) => {
    if (!body.contains(e.relatedTarget)) {
      body.classList.remove("drop-target");
    }
  });
  body.addEventListener("drop", (e) => {
    e.preventDefault();
    body.classList.remove("drop-target");
    const exerciseId = e.dataTransfer.getData("application/x-exercise-id");
    if (exerciseId) {
      addExerciseToTemplate(tmpl.id, exerciseId);
    }
  });

  // Items list (drag-to-reorder)
  const itemList = document.createElement("ul");
  itemList.className = "item-list template-item-list";
  itemList.dataset.templateId = tmpl.id;

  if (!tmpl.items.length) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "No exercises. Add below.";
    itemList.appendChild(li);
  } else {
    tmpl.items.forEach((item, idx) => {
      const li = document.createElement("li");
      li.draggable = true;
      li.dataset.itemIndex = idx;
      li.dataset.templateId = tmpl.id;
      li.classList.add("template-item");

      li.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-template-item", JSON.stringify({
          templateId: tmpl.id,
          index: idx,
        }));
        e.dataTransfer.effectAllowed = "move";
        li.classList.add("dragging");
        // Prevent exercise drag from triggering
        e.stopPropagation();
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("dragging");
        clearDropIndicators(itemList);
      });

      // Drop target for reordering
      li.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("application/x-template-item")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        clearDropIndicators(itemList);
        const rect = li.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          li.classList.add("drop-above");
        } else {
          li.classList.add("drop-below");
        }
      });
      li.addEventListener("dragleave", () => {
        li.classList.remove("drop-above", "drop-below");
      });
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearDropIndicators(itemList);
        const payload = e.dataTransfer.getData("application/x-template-item");
        if (!payload) return;
        const { templateId: srcTmplId, index: srcIdx } = JSON.parse(payload);
        if (srcTmplId !== tmpl.id) return;

        const rect = li.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        let targetIdx = idx;
        if (e.clientY >= midY) targetIdx++;
        reorderTemplateItem(tmpl.id, srcIdx, targetIdx);
      });

      // Drag handle
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "\u2261";
      li.appendChild(handle);

      // Badge for superset
      if (item.content.superset) {
        const badge = document.createElement("span");
        badge.className = "item-badge";
        badge.textContent = "SS";
        li.appendChild(badge);
      }

      const label = document.createElement("span");
      label.className = "item-name";
      label.textContent = itemLabel(item);
      li.appendChild(label);

      li.appendChild(createRemoveBtn(() => removeTemplateItem(tmpl.id, item.id)));

      itemList.appendChild(li);
    });
  }
  body.appendChild(itemList);

  // Actions
  const actions = document.createElement("div");
  actions.className = "template-card-actions";

  // Add exercise dropdown + button
  const exSelect = document.createElement("select");
  exSelect.className = "template-exercise-select";
  populateExerciseSelect(exSelect);

  const addExBtn = document.createElement("button");
  addExBtn.type = "button";
  addExBtn.className = "btn btn-secondary";
  addExBtn.textContent = "Add Exercise";
  addExBtn.addEventListener("click", () => {
    if (!exSelect.value) return;
    addExerciseToTemplate(tmpl.id, exSelect.value);
  });

  actions.appendChild(exSelect);
  actions.appendChild(addExBtn);

  // Add superset button
  const ssBtn = document.createElement("button");
  ssBtn.type = "button";
  ssBtn.className = "btn btn-secondary";
  ssBtn.textContent = "Add Superset";
  ssBtn.addEventListener("click", () => showSupersetForm(tmpl.id, body));
  actions.appendChild(ssBtn);

  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

function activeExercises() {
  return state.exercises.filter((e) => !e.isHidden && !e.isDeleted);
}

function populateExerciseSelect(select) {
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select exercise...";
  select.appendChild(placeholder);
  for (const ex of activeExercises()) {
    const opt = document.createElement("option");
    opt.value = ex.id;
    opt.textContent = ex.name;
    select.appendChild(opt);
  }
}

function refreshAllTemplateSelects() {
  const selects = document.querySelectorAll(".template-exercise-select");
  for (const sel of selects) {
    populateExerciseSelect(sel);
  }
}

function addTemplate(name) {
  const trimmed = name.trim();
  if (!trimmed) {
    showError("#template-error", "Template name is required.");
    return;
  }
  clearError("#template-error");
  state.templates.unshift({
    id: genId(),
    name: trimmed,
    items: [],
  });
  renderTemplates();
  refreshPlanTemplateSelect();
}

function removeTemplate(id) {
  state.templates = state.templates.filter((t) => t.id !== id);
  if (state.plan) {
    state.plan.templateIds = state.plan.templateIds.filter((tid) => tid !== id);
  }
  renderTemplates();
  refreshPlanTemplateSelect();
  renderPlanTemplates();
  renderProgressions();
}

function addExerciseToTemplate(templateId, exerciseId) {
  const tmpl = state.templates.find((t) => t.id === templateId);
  if (!tmpl) return;
  tmpl.items.push({
    id: genId(),
    content: { exercise: { exerciseId: exerciseId } },
  });
  renderTemplates();
  renderProgressions();
}

function removeTemplateItem(templateId, itemId) {
  const tmpl = state.templates.find((t) => t.id === templateId);
  if (!tmpl) return;
  tmpl.items = tmpl.items.filter((i) => i.id !== itemId);
  // Clean up progressions
  if (state.plan && state.plan.progressions) {
    delete state.plan.progressions[itemId];
  }
  renderTemplates();
  renderProgressions();
}

function reorderTemplateItem(templateId, fromIndex, toIndex) {
  const tmpl = state.templates.find((t) => t.id === templateId);
  if (!tmpl) return;
  if (fromIndex === toIndex || fromIndex === toIndex - 1) return;
  const [item] = tmpl.items.splice(fromIndex, 1);
  const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
  tmpl.items.splice(insertAt, 0, item);
  renderTemplates();
}

function clearDropIndicators(container) {
  for (const el of container.querySelectorAll(".drop-above, .drop-below")) {
    el.classList.remove("drop-above", "drop-below");
  }
}

// Superset form
function showSupersetForm(templateId, parentBody) {
  // Remove existing superset form if any
  const existing = parentBody.querySelector(".superset-form");
  if (existing) existing.remove();

  const available = activeExercises();
  if (!available.length) return;

  const form = document.createElement("div");
  form.className = "superset-form";

  const checkboxes = document.createElement("div");
  checkboxes.className = "superset-checkboxes";

  for (const ex of available) {
    const lbl = document.createElement("label");
    lbl.className = "exercise-checkbox";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = ex.id;
    lbl.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = ex.name;
    lbl.appendChild(span);
    checkboxes.appendChild(lbl);
  }
  form.appendChild(checkboxes);

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "btn btn-primary";
  confirmBtn.textContent = "Create Superset";
  confirmBtn.addEventListener("click", () => {
    const checked = [
      ...form.querySelectorAll('input[type="checkbox"]:checked'),
    ].map((cb) => cb.value);
    if (checked.length < 2 || checked.length > 3) {
      alert("Select 2 or 3 exercises for a superset.");
      return;
    }
    const tmpl = state.templates.find((t) => t.id === templateId);
    if (!tmpl) return;
    tmpl.items.push({
      id: genId(),
      content: { superset: { exerciseIds: checked } },
    });
    renderTemplates();
    renderProgressions();
  });
  form.appendChild(confirmBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => form.remove());
  form.appendChild(cancelBtn);

  parentBody.appendChild(form);
}

// ---------------------------------------------------------------------------
// 3. Plan
// ---------------------------------------------------------------------------

function ensurePlan() {
  if (!state.plan) {
    state.plan = {
      id: genId(),
      name: "",
      notes: null,
      templateIds: [],
      isLooping: false,
      progressions: {},
    };
  }
}

function refreshPlanTemplateSelect() {
  const select = $("#plan-template-select");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select template...";
  select.appendChild(placeholder);
  for (const t of state.templates) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
}

function renderPlanTemplates() {
  const list = $("#plan-templates");
  list.innerHTML = "";
  if (!state.plan || !state.plan.templateIds.length) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "No templates in plan yet.";
    list.appendChild(li);
    return;
  }
  state.plan.templateIds.forEach((tid, idx) => {
    const tmpl = state.templates.find((t) => t.id === tid);
    const li = document.createElement("li");
    li.draggable = true;
    li.classList.add("plan-template-item");
    li.dataset.planIndex = idx;

    li.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(
        "application/x-plan-template",
        String(idx)
      );
      e.dataTransfer.effectAllowed = "move";
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      clearDropIndicators(list);
    });
    li.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-plan-template")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropIndicators(list);
      const rect = li.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        li.classList.add("drop-above");
      } else {
        li.classList.add("drop-below");
      }
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drop-above", "drop-below");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      clearDropIndicators(list);
      const srcIdx = parseInt(
        e.dataTransfer.getData("application/x-plan-template"),
        10
      );
      if (isNaN(srcIdx)) return;
      const rect = li.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      let targetIdx = idx;
      if (e.clientY >= midY) targetIdx++;
      reorderPlanTemplate(srcIdx, targetIdx);
    });

    // Drag handle
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "\u2261";
    li.appendChild(handle);

    const label = document.createElement("span");
    label.className = "item-name";
    label.textContent = tmpl ? tmpl.name : "(deleted)";
    li.appendChild(label);

    li.appendChild(createRemoveBtn(() => removePlanTemplate(idx)));

    list.appendChild(li);
  });
}

function addTemplateToPlan(templateId) {
  if (!templateId) return;
  ensurePlan();

  // If this template is already in the plan, create a copy with new IDs
  if (state.plan.templateIds.includes(templateId)) {
    const original = state.templates.find((t) => t.id === templateId);
    if (!original) return;
    const copy = {
      id: genId(),
      name: original.name,
      items: original.items.map((item) => ({
        id: genId(),
        content: JSON.parse(JSON.stringify(item.content)),
      })),
    };
    state.templates.push(copy);
    state.plan.templateIds.push(copy.id);
  } else {
    state.plan.templateIds.push(templateId);
  }

  renderTemplates();
  refreshPlanTemplateSelect();
  renderPlanTemplates();
  renderProgressions();
}

function removePlanTemplate(index) {
  state.plan.templateIds.splice(index, 1);
  renderPlanTemplates();
  renderProgressions();
}

function reorderPlanTemplate(fromIndex, toIndex) {
  const arr = state.plan.templateIds;
  if (fromIndex === toIndex || fromIndex === toIndex - 1) return;
  const [item] = arr.splice(fromIndex, 1);
  const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
  arr.splice(insertAt, 0, item);
  renderPlanTemplates();
  renderProgressions();
}

// ---------------------------------------------------------------------------
// 4. Progressions
// ---------------------------------------------------------------------------

function getAllPlanItems() {
  if (!state.plan) return [];
  const items = [];
  state.plan.templateIds.forEach((tid, planIdx) => {
    const tmpl = state.templates.find((t) => t.id === tid);
    if (!tmpl) return;
    for (const item of tmpl.items) {
      items.push({ templateName: tmpl.name, planIndex: planIdx, item });
    }
  });
  return items;
}

function renderProgressions() {
  const section = $("#progressions-section");
  const allItems = getAllPlanItems();

  if (!allItems.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  ensurePlan();
  if (!state.plan.progressions) state.plan.progressions = {};

  const container = $("#progressions-list");
  container.innerHTML = "";

  let currentPlanIndex = null;
  for (const { templateName, planIndex, item } of allItems) {
    if (planIndex !== currentPlanIndex) {
      currentPlanIndex = planIndex;
      const heading = document.createElement("div");
      heading.className = "progression-template-heading";
      heading.textContent = templateName;
      container.appendChild(heading);
    }
    container.appendChild(buildProgressionCard(item, templateName));
  }
}

function buildProgressionCard(item, templateName) {
  const card = document.createElement("div");
  card.className = "progression-card";

  // Header: exercise name + template + 1RM + PB
  const header = document.createElement("div");
  header.className = "progression-header";

  const nameSpan = document.createElement("span");
  nameSpan.className = "progression-name";
  nameSpan.textContent = itemLabel(item);
  header.appendChild(nameSpan);

  const tmplSpan = document.createElement("span");
  tmplSpan.className = "progression-template";
  tmplSpan.textContent = templateName;
  header.appendChild(tmplSpan);

  // PB and est 1RM
  const oneRM = itemOneRM(item);
  if (item.content.exercise) {
    const pb = getExercisePB(item.content.exercise.exerciseId);
    if (pb) {
      const pbSpan = document.createElement("span");
      pbSpan.className = "personal-best";
      pbSpan.textContent = `PB: ${pb.weight}kg x${pb.reps}`;
      header.appendChild(pbSpan);
    }
    if (oneRM) {
      const rmSpan = document.createElement("span");
      rmSpan.className = "est-1rm";
      rmSpan.textContent = `1RM: ${oneRM}kg`;
      header.appendChild(rmSpan);
    }
  }

  // Percentage hints (right-aligned in header)
  if (oneRM) {
    const hints = document.createElement("div");
    hints.className = "progression-hints";
    for (const pct of [50, 75, 80, 90]) {
      const val = roundToPlates(oneRM * pct / 100);
      const span = document.createElement("span");
      span.className = "hint-chip";
      span.textContent = `${pct}% \u2248 ${val}kg`;
      span.title = `Click to insert ${val}kg`;
      span.addEventListener("click", () => {
        const targets = state.plan.progressions[item.id] || [];
        const emptyIdx = targets.findIndex((t) => !t.trim());
        if (emptyIdx >= 0) {
          const inputs = card.querySelectorAll(".progression-target-input");
          if (inputs[emptyIdx]) {
            inputs[emptyIdx].value = `${val}kg`;
            inputs[emptyIdx].dispatchEvent(new Event("input"));
          }
        }
      });
      hints.appendChild(span);
    }
    header.appendChild(hints);
  }

  card.appendChild(header);

  // Targets (iterations as rows)
  const targetsContainer = document.createElement("div");
  targetsContainer.className = "progression-targets";

  const targets = state.plan.progressions[item.id] || [];
  for (let i = 0; i < targets.length; i++) {
    targetsContainer.appendChild(buildTargetRow(item.id, i, targets[i], targetsContainer));
  }

  card.appendChild(targetsContainer);

  // Add iteration button
  if (targets.length < 12) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn-add-iteration";
    addBtn.textContent = `+ Add iteration ${targets.length + 1}`;
    addBtn.addEventListener("click", () => {
      if (!state.plan.progressions[item.id]) {
        state.plan.progressions[item.id] = [];
      }
      if (state.plan.progressions[item.id].length >= 12) return;
      state.plan.progressions[item.id].push("");
      renderProgressions();
    });
    card.appendChild(addBtn);
  }

  return card;
}

function buildTargetRow(itemId, index, value, container) {
  const row = document.createElement("div");
  row.className = "progression-target-row";

  const num = document.createElement("span");
  num.className = "target-num";
  num.textContent = `${index + 1}.`;
  row.appendChild(num);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "progression-target-input";
  input.maxLength = 100;
  input.value = value || "";
  input.placeholder = "e.g. 3x10 60kg";
  input.addEventListener("input", () => {
    if (!state.plan.progressions[itemId]) {
      state.plan.progressions[itemId] = [];
    }
    while (state.plan.progressions[itemId].length <= index) {
      state.plan.progressions[itemId].push("");
    }
    state.plan.progressions[itemId][index] = input.value;
  });
  row.appendChild(input);

  row.appendChild(createRemoveBtn(() => {
    if (state.plan.progressions[itemId]) {
      state.plan.progressions[itemId].splice(index, 1);
    }
    renderProgressions();
  }));

  return row;
}

// ---------------------------------------------------------------------------
// 5. Export
// ---------------------------------------------------------------------------

function showValidationErrors(errors) {
  const container = $("#validation-errors");
  container.innerHTML = "";
  if (!errors.length) return;
  const ul = document.createElement("ul");
  for (const err of errors) {
    const li = document.createElement("li");
    li.textContent = err;
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

function syncPlanFromInputs() {
  ensurePlan();
  state.plan.name = $("#plan-name").value.trim();
  state.plan.isLooping = $("#plan-looping").checked;
}

function doPreview() {
  syncPlanFromInputs();
  const errors = validateState(state);
  showValidationErrors(errors);
  if (errors.length) return;

  const json = buildExportJSON(state);
  $("#preview-json").textContent = json;
  $("#preview-modal").hidden = false;
}

function doDownload() {
  syncPlanFromInputs();
  const errors = validateState(state);
  showValidationErrors(errors);
  if (errors.length) return;

  const json = buildExportJSON(state);
  downloadFile(json, state.plan.name);
}

function downloadFile(json, planName) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  // Clean filename: keep alphanumeric, spaces, hyphens, underscores
  const safeName = planName.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "plan";
  a.href = url;
  a.download = `${safeName}.lifted`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  // Import file — button
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
  });

  // Import file — dropzone
  const dropzone = $("#import-dropzone");
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dropzone.classList.add("drag-over");
  });
  dropzone.addEventListener("dragleave", (e) => {
    if (!dropzone.contains(e.relatedTarget)) {
      dropzone.classList.remove("drag-over");
    }
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleImportFile(file);
  });

  // Exercise form
  $("#exercise-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const nameInput = $("#exercise-name");
    const notesInput = $("#exercise-notes");
    addExercise(nameInput.value, notesInput.value);
    nameInput.value = "";
    notesInput.value = "";
    nameInput.focus();
  });

  // Template form
  $("#template-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const nameInput = $("#template-name");
    addTemplate(nameInput.value);
    nameInput.value = "";
    nameInput.focus();
  });

  // Plan - add template
  $("#plan-add-template-btn").addEventListener("click", () => {
    const select = $("#plan-template-select");
    addTemplateToPlan(select.value);
    select.value = "";
  });

  // Plan - name/looping sync
  $("#plan-name").addEventListener("input", () => {
    ensurePlan();
    state.plan.name = $("#plan-name").value.trim();
  });
  $("#plan-notes").addEventListener("input", () => {
    ensurePlan();
    const trimmed = $("#plan-notes").value.trim();
    state.plan.notes = trimmed || null;
  });
  $("#plan-looping").addEventListener("change", () => {
    ensurePlan();
    state.plan.isLooping = $("#plan-looping").checked;
  });

  // Export buttons
  $("#preview-btn").addEventListener("click", doPreview);
  $("#download-btn").addEventListener("click", doDownload);
  $("#modal-download-btn").addEventListener("click", doDownload);

  // Modal close
  $("#modal-close-btn").addEventListener("click", () => {
    $("#preview-modal").hidden = true;
  });
  $("#preview-modal").addEventListener("click", (e) => {
    if (e.target === $("#preview-modal")) {
      $("#preview-modal").hidden = true;
    }
  });

  // Plan templates drop zone — accept template cards from Templates section
  const planList = $("#plan-templates");
  planList.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("application/x-template-to-plan")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      planList.classList.add("drop-target");
    }
  });
  planList.addEventListener("dragleave", (e) => {
    if (!planList.contains(e.relatedTarget)) {
      planList.classList.remove("drop-target");
    }
  });
  planList.addEventListener("drop", (e) => {
    const templateId = e.dataTransfer.getData("application/x-template-to-plan");
    if (templateId) {
      e.preventDefault();
      planList.classList.remove("drop-target");
      addTemplateToPlan(templateId);
    }
  });

  // Collapsible sections
  document.querySelectorAll(".section-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const section = toggle.closest(".collapsible");
      if (!section) return;
      const collapsed = section.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", String(!collapsed));
    });
  });

  // Initial render
  renderExercises();
  renderTemplates();
  refreshPlanTemplateSelect();
  renderPlanTemplates();
});
