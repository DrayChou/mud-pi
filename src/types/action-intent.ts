export type ActionKind =
  | "observe"
  | "navigate"
  | "interact"
  | "communicate"
  | "combat"
  | "inventory"
  | "objectives"
  | "story_status"
  | "unknown";

export type EntityKind = "player" | "room" | "npc" | "item" | "scene_object";

export interface EntityReference {
  text: string;
  role: "target" | "tool" | "destination";
  expectedKinds: EntityKind[];
}

export interface ActionIntent {
  primaryKind: ActionKind;
  goal?: string;
  approach?: string;
  questions: string[];
  constraints: string[];
  targets: EntityReference[];
  tools: EntityReference[];
  destination?: EntityReference;
  direction?: string;
  raw: string;
  confidence: number;
  /** Compatibility bridge while Runtime still executes ParsedCommand. */
  legacy: { verb: string; args: Record<string, string> };
}

export type ReferenceResolution =
  | "exact"
  | "alias"
  | "contextual"
  | "narrated_unregistered"
  | "ambiguous"
  | "missing";

export interface ResolvedReference extends EntityReference {
  resolution: ReferenceResolution;
  entityId?: string;
  entityKind?: EntityKind;
  candidates?: Array<{ entityId: string; entityKind: EntityKind; name: string }>;
}

export interface ResolvedActionIntent extends ActionIntent {
  resolvedTargets: ResolvedReference[];
  resolvedTools: ResolvedReference[];
  resolvedDestination?: ResolvedReference;
  requiresSemanticAdjudication: boolean;
}
