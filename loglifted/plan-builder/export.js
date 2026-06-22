// export.js — JSON assembly and validation for .lifted v2.0

"use strict";

/**
 * Validate state before export.
 * Returns an array of error strings (empty = valid).
 */
function validateState(state) {
  const errors = [];

  if (!state.exercises.length) {
    errors.push("At least 1 exercise is required.");
  }

  if (!state.templates.length) {
    errors.push("At least 1 template is required.");
  } else {
    for (const t of state.templates) {
      if (!t.items.length) {
        errors.push(`Template "${t.name}" has no exercises.`);
      }
    }
  }

  if (!state.plan) {
    errors.push("Plan is required.");
  } else {
    if (!state.plan.name.trim()) {
      errors.push("Plan name is required.");
    }
    if (!state.plan.templateIds.length) {
      errors.push("Plan must contain at least 1 template.");
    }
  }

  // Validate references
  const exerciseIds = new Set(state.exercises.map((e) => e.id));
  for (const t of state.templates) {
    for (const item of t.items) {
      const ids = item.content.exercise
        ? [item.content.exercise.exerciseId]
        : item.content.superset.exerciseIds;
      for (const eid of ids) {
        if (!exerciseIds.has(eid)) {
          errors.push(`Template "${t.name}" references unknown exercise ID.`);
        }
      }
      if (item.content.superset) {
        const count = item.content.superset.exerciseIds.length;
        if (count < 1 || count > 3) {
          errors.push(
            `Superset in "${t.name}" must have 1-3 exercises (has ${count}).`
          );
        }
      }
    }
  }

  // Validate progressions
  if (state.plan && state.plan.progressions) {
    for (const [itemId, targets] of Object.entries(state.plan.progressions)) {
      if (targets.length > 12) {
        errors.push(`Progression for item has more than 12 cycles.`);
      }
      for (const t of targets) {
        if (t.length > 100) {
          errors.push(`Progression target exceeds 100 characters.`);
        }
      }
    }
  }

  return errors;
}

/**
 * Build the .lifted v2.0 JSON string from state.
 * Assumes state has been validated.
 */
function buildExportJSON(state) {
  const exercises = state.exercises.map((e) => {
    const obj = { id: e.id, name: e.name };
    if (e.notes) {
      obj.notes = e.notes;
    }
    if (e.isHidden) {
      obj.isHidden = true;
    }
    if (e.isDeleted) {
      obj.isDeleted = true;
    }
    if (e.restSeconds != null) {
      obj.restSeconds = e.restSeconds;
    }
    if (e.weightRoundingStepKg != null) {
      obj.weightRoundingStepKg = e.weightRoundingStepKg;
    }
    return obj;
  });

  const templates = state.templates.map((t) => ({
    id: t.id,
    name: t.name,
    items: t.items.map((item) => ({
      id: item.id,
      content: item.content,
    })),
  }));

  const plans = [];
  if (state.plan) {
    const planObj = {
      id: state.plan.id,
      name: state.plan.name,
      templateIds: state.plan.templateIds,
      currentIndex: 0,
      isLooping: state.plan.isLooping,
      cycleNumber: 1,
    };
    if (state.plan.notes) {
      planObj.notes = state.plan.notes;
    }
    // Only include progressions if non-empty
    // Swift encodes [UUID: [String]] as alternating array [key, value, key, value, ...]
    if (state.plan.progressions) {
      const arr = [];
      for (const [key, val] of Object.entries(state.plan.progressions)) {
        const nonEmpty = val.filter((s) => s.trim() !== "");
        if (nonEmpty.length) {
          arr.push(key.toUpperCase(), val);
        }
      }
      if (arr.length) {
        planObj.progressions = arr;
      }
    }
    plans.push(planObj);
  }

  const data = {
    activePlanId: null,
    exercises: exercises,
    exportedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    plans: plans,
    templates: templates,
    version: "2.0",
    workouts: [],
  };

  // Sort keys to match Swift's .sortedKeys output
  return JSON.stringify(data, sortedReplacer, 2);
}

/**
 * JSON.stringify replacer that sorts object keys alphabetically,
 * matching Swift's JSONEncoder .sortedKeys behavior.
 */
function sortedReplacer(key, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = value[k];
    }
    return sorted;
  }
  return value;
}
