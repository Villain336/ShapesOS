// ShapesOS — Agentic OS UI kit as React components (docs/design/kit/*.png,
// docs/design/DESIGN.md). Shared atoms live here; pages reuse them instead of
// restyling per page. Status logic lives in lib/aos (pure, unit-tested).

export { LogoMark, Wordmark } from "./LogoMark";
export { StatusShape, type ShapeTone, type StatusShapeProps } from "./StatusShape";
export { StatusBadge } from "./StatusBadge";
export { ToolChip, toolIcon, TOOL_ICONS } from "./ToolChip";
export { AgentAvatar, AvatarStack, CountBadge, KeyCap, KeyCaps } from "./AgentAvatar";
export { aosButton, type AosButtonVariant, type AosButtonSize } from "./button";
export { CroppedShape, statusSurface, shapeFillFor } from "./CroppedShape";
export { AgentCard, CardActionButton, type CardAction } from "./AgentCard";
export { AgentTree } from "./AgentTree";
export { LeadAgentCard } from "./LeadAgentCard";
export { Banner, type BannerAction } from "./Banner";
export { ToastView, type ToastViewAction } from "./Toast";
export { LiveActivity, LiveCounts, LiveRunStrip, type LiveRun, type LiveChip } from "./LiveActivity";
export { RunTimeline, ToolCallBlock, AsksFirstChip, type TimelineStep, type ToolCall } from "./RunTimeline";
export { ApprovalCard, type ApprovalItem, type ApprovalCardMode } from "./ApprovalCard";
export { PermissionSegmented, PERMISSION_OPTIONS, Switch, SwitchRow, Field, FieldMessage, type Permission } from "./Controls";
export { MenuSurface, MenuLabel, MenuRow, MenuSeparator } from "./Menu";
export { FilterPill } from "./FilterPill";
