// Config TUI buffer mutation helpers — pure functions, no I/O.
// Split from state.ts (Phase 1).

import type { ConfigBuffer, PhaseOverride } from "./model.js";
import type { ConfigLayer } from "../../config-writer.js";
import type { PersonaModel } from "../../config-layer.js";
import type { PipelineConfig } from "../../config-layer.js";

export function writePersonaEntry(
  buffer: ConfigBuffer,
  layer: ConfigLayer,
  persona: string,
  entry: PersonaModel,
): ConfigBuffer {
  const targetLayer = buffer[layer];
  const personaModels = { ...(targetLayer["persona-models"] ?? {}) };
  personaModels[persona] = entry;
  const updatedLayer = { ...targetLayer, "persona-models": personaModels };
  return { ...buffer, [layer]: updatedLayer };
}

export function deletePersonaEntry(
  buffer: ConfigBuffer,
  layer: ConfigLayer,
  persona: string,
): ConfigBuffer {
  const targetLayer = buffer[layer];
  const personaModels = { ...(targetLayer["persona-models"] ?? {}) };
  if (!(persona in personaModels)) return buffer;
  delete personaModels[persona];
  const updatedLayer = { ...targetLayer };
  if (Object.keys(personaModels).length === 0) {
    delete updatedLayer["persona-models"];
  } else {
    updatedLayer["persona-models"] = personaModels;
  }
  return { ...buffer, [layer]: updatedLayer };
}

export function writePhaseOverride(
  buffer: ConfigBuffer,
  pipelineName: string,
  phaseRole: string,
  override: PhaseOverride,
): ConfigBuffer {
  const project = { ...buffer.project };
  const pipelines = { ...(project.pipelines ?? {}) };
  const pipeline: PipelineConfig = { ...(pipelines[pipelineName] ?? {}) };
  const phases = { ...(pipeline.phases ?? {}) };
  phases[phaseRole] = { ...phases[phaseRole], "model-override": override };
  pipeline.phases = phases;
  pipelines[pipelineName] = pipeline;
  project.pipelines = pipelines;
  return { ...buffer, project };
}

export function clearPhaseOverride(
  buffer: ConfigBuffer,
  pipelineName: string,
  phaseRole: string,
): ConfigBuffer {
  const existingPipeline = buffer.project.pipelines?.[pipelineName];
  const existingPhases = existingPipeline?.phases;
  if (!existingPhases) return buffer;
  const existingPhase = existingPhases[phaseRole];
  if (!existingPhase || existingPhase["model-override"] === undefined) return buffer;

  const project = { ...buffer.project };
  const pipelines = { ...(project.pipelines ?? {}) };
  const pipeline: PipelineConfig = { ...pipelines[pipelineName] };
  const phases = { ...existingPhases };
  const nextPhase = { ...phases[phaseRole] };
  delete nextPhase["model-override"];
  if (Object.keys(nextPhase).length === 0) {
    delete phases[phaseRole];
  } else {
    phases[phaseRole] = nextPhase;
  }
  if (Object.keys(phases).length === 0) {
    delete pipeline.phases;
  } else {
    pipeline.phases = phases;
  }

  // If the pipeline has no persona-models and no remaining phase overrides, drop it.
  const hasPipelinePersonaModels =
    pipeline["persona-models"] !== undefined &&
    Object.keys(pipeline["persona-models"]).length > 0;
  const hasPhases = Object.keys(pipeline.phases ?? {}).length > 0;
  if (!hasPipelinePersonaModels && !hasPhases) {
    delete pipelines[pipelineName];
  } else {
    pipelines[pipelineName] = pipeline;
  }

  if (Object.keys(pipelines).length === 0) {
    delete project.pipelines;
  } else {
    project.pipelines = pipelines;
  }

  return { ...buffer, project };
}