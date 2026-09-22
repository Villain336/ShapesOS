// Marketr — Phosphor icon client boundary for server components.
//
// `@phosphor-icons/react` cannot be evaluated in the Next 16 server chunk
// (Turbopack build: `createContext is not a function`). Any server component
// that needs an icon imports it from here instead of the package directly.
// This file is "use client", so the icons render as a client island while the
// surrounding page stays server-rendered.

"use client";

export {
  ArrowLeft,
  Bell,
  CaretRight,
  ChatCentered,
  CheckCircle,
  Clock,
  CodeSimple,
  Crosshair,
  Envelope,
  FileText,
  Gauge,
  Globe,
  Kanban,
  Key,
  Lightning,
  LinkSimple,
  ListChecks,
  MapPin,
  Megaphone,
  Network,
  Palette,
  Pulse,
  Quotes,
  Rocket,
  ShareNetwork,
  ShieldCheck,
  Stack,
  Target,
  TrendDown,
  TrendUp,
  Warning,
} from "@phosphor-icons/react";
