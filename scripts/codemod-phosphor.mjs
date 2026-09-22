// One-shot codemod: lucide-react -> @phosphor-icons/react.
// Usage: node scripts/codemod-phosphor.mjs
import { execSync } from "node:child_process";
import fs from "node:fs";

const MAP = {
  Activity: "Pulse",
  AlertTriangle: "Warning",
  AlignEndHorizontal: "ChartBarHorizontal",
  ArrowLeft: "ArrowLeft",
  ArrowUp: "ArrowUp",
  BarChart3: "ChartBar",
  Bell: "Bell",
  Bold: "TextB",
  Bot: "Robot",
  Braces: "BracketsCurly",
  CalendarDays: "CalendarDots",
  Check: "Check",
  CheckIcon: "Check",
  ChevronDown: "CaretDown",
  ChevronDownIcon: "CaretDown",
  ChevronRight: "CaretRight",
  ChevronRightIcon: "CaretRight",
  ChevronUp: "CaretUp",
  ChevronUpIcon: "CaretUp",
  ChevronsUpDown: "CaretUpDown",
  Clock: "Clock",
  Code: "Code",
  Code2: "CodeSimple",
  Copy: "Copy",
  Crosshair: "Crosshair",
  Database: "Database",
  Download: "Download",
  ExternalLink: "ArrowSquareOut",
  Eye: "Eye",
  FileBarChart: "ChartBar",
  FileText: "FileText",
  Film: "FilmStrip",
  FolderKanban: "Kanban",
  Gauge: "Gauge",
  GitFork: "GitFork",
  Globe: "Globe",
  GripVertical: "DotsSixVertical",
  Heading: "TextH",
  Heading1: "TextHOne",
  Heading2: "TextHTwo",
  Heading3: "TextHThree",
  History: "ClockCounterClockwise",
  Image: "Image",
  Inbox: "Tray",
  Italic: "TextItalic",
  KeyRound: "Key",
  Layers: "Stack",
  LayoutGrid: "SquaresFour",
  Leaf: "Leaf",
  Link: "Link",
  Link2: "LinkSimple",
  Link2Off: "LinkSimpleBreak",
  List: "List",
  ListChecks: "ListChecks",
  ListOrdered: "ListNumbers",
  ListTodo: "ListPlus",
  Loader2: "CircleNotch",
  LogOut: "SignOut",
  Mail: "Envelope",
  MapPin: "MapPin",
  Megaphone: "Megaphone",
  Menu: "List",
  MessageCircleQuestion: "Question",
  MessageSquare: "ChatCentered",
  Minus: "Minus",
  MousePointer2: "Cursor",
  MousePointerClick: "CursorClick",
  Network: "Network",
  OctagonAlert: "WarningOctagon",
  Palette: "Palette",
  PanelTop: "Rectangle",
  PenLine: "PencilLine",
  Pencil: "Pencil",
  Play: "Play",
  Plug: "Plug",
  Plus: "Plus",
  Radar: "Target",
  RefreshCw: "ArrowClockwise",
  Rocket: "Rocket",
  Save: "FloppyDisk",
  ScanSearch: "Scan",
  Scissors: "Scissors",
  Search: "MagnifyingGlass",
  Send: "PaperPlane",
  Settings2: "GearSix",
  Share2: "ShareNetwork",
  ShieldCheck: "ShieldCheck",
  SlidersHorizontal: "SlidersHorizontal",
  Smile: "Smiley",
  Sparkles: "Sparkle",
  SquareCode: "CodeSimple",
  Strikethrough: "TextStrikethrough",
  Table: "Table",
  TextAlignCenter: "TextAlignCenter",
  TextAlignEnd: "TextAlignRight",
  TextAlignStart: "TextAlignLeft",
  TextQuote: "Quotes",
  Timer: "Timer",
  Trash2: "Trash",
  TrendingDown: "TrendDown",
  TrendingUp: "TrendUp",
  Type: "TextT",
  Underline: "TextUnderline",
  Unplug: "XCircle",
  Users: "Users",
  Wallet: "Wallet",
  Webhook: "WebhooksLogo",
  Workflow: "GitBranch",
  X: "X",
  XCircle: "XCircle",
  XIcon: "X",
  Zap: "Lightning",
};

const files = execSync('grep -rl "lucide-react" app components lib --include="*.tsx" --include="*.ts"')
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);

let changed = 0;
for (const f of files) {
  let src = fs.readFileSync(f, "utf8");
  const re = /import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g;
  let m;
  let newSrc = src;
  let fileChanged = false;
  while ((m = re.exec(src))) {
    const parts = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((tok) => {
        const am = tok.match(/^(\w+)\s+as\s+(\w+)$/);
        const orig = am ? am[1] : tok;
        const alias = am ? am[2] : null;
        const mapped = MAP[orig];
        if (!mapped) {
          console.warn(`UNMAPPED ${orig} in ${f}`);
          return tok;
        }
        if (alias) return mapped === alias ? mapped : `${mapped} as ${alias}`;
        return mapped;
      });
    // dedupe collisions: same mapped export with different local names -> alias
    const seen = new Map();
    const final = parts.map((p) => {
      const am = p.match(/^(\w+)\s+as\s+(\w+)$/);
      const exp = am ? am[1] : p;
      const local = am ? am[2] : p;
      if (seen.has(exp) && seen.get(exp) !== local) {
        return `${exp} as ${local}`;
      }
      seen.set(exp, local);
      return p;
    });
    const replacement = `import {\n${final.map((p) => `  ${p},`).join("\n")}\n} from "@phosphor-icons/react"`;
    newSrc = newSrc.replace(m[0], replacement);
    fileChanged = true;
  }
  if (fileChanged) {
    // strip lucide-only strokeWidth props (Phosphor uses weight instead)
    newSrc = newSrc.replace(/\s+strokeWidth=\{[^}]*\}/g, "");
    fs.writeFileSync(f, newSrc);
    changed++;
  }
}
console.log(`converted ${changed} files`);

// Update the workflow catalog icon-name strings to phosphor names.
const cat = "lib/workflow/catalog.ts";
let catSrc = fs.readFileSync(cat, "utf8");
const catMap = {
  TrendingDown: "TrendDown",
  Radar: "Target",
  Webhook: "WebhooksLogo",
  Sparkles: "Sparkle",
  ScanSearch: "Scan",
  Link2: "LinkSimple",
  FileBarChart: "ChartBar",
};
for (const [a, b] of Object.entries(catMap)) {
  catSrc = catSrc.replaceAll(`icon: "${a}"`, `icon: "${b}"`);
}
catSrc = catSrc.replace("Lucide icon name rendered client-side.", "Phosphor icon name rendered client-side.");
fs.writeFileSync(cat, catSrc);
console.log("catalog updated");
