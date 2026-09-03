import { onMount, splitProps, type ComponentProps } from "solid-js"
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon"
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon"
import Archive02Icon from "@hugeicons/core-free-icons/Archive02Icon"
import ArrowDownToLineIcon from "@hugeicons/core-free-icons/ArrowDownToLineIcon"
import ArrowExpand01Icon from "@hugeicons/core-free-icons/ArrowExpand01Icon"
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon"
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon"
import ArrowShrink01Icon from "@hugeicons/core-free-icons/ArrowShrink01Icon"
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon"
import BanIcon from "@hugeicons/core-free-icons/BanIcon"
import BotIcon from "@hugeicons/core-free-icons/BotIcon"
import Brain02Icon from "@hugeicons/core-free-icons/Brain02Icon"
import BubbleChatIcon from "@hugeicons/core-free-icons/BubbleChatIcon"
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon"
import CancelCircleIcon from "@hugeicons/core-free-icons/CancelCircleIcon"
import CheckListIcon from "@hugeicons/core-free-icons/CheckListIcon"
import CheckmarkCircle01Icon from "@hugeicons/core-free-icons/CheckmarkCircle01Icon"
import ChevronDownIcon from "@hugeicons/core-free-icons/ChevronDownIcon"
import ChevronLeftIcon from "@hugeicons/core-free-icons/ChevronLeftIcon"
import ChevronRightIcon from "@hugeicons/core-free-icons/ChevronRightIcon"
import ChevronsRightIcon from "@hugeicons/core-free-icons/ChevronsRightIcon"
import CloudUploadIcon from "@hugeicons/core-free-icons/CloudUploadIcon"
import CodeSquareIcon from "@hugeicons/core-free-icons/CodeSquareIcon"
import Comment01Icon from "@hugeicons/core-free-icons/Comment01Icon"
import CommandLineIcon from "@hugeicons/core-free-icons/CommandLineIcon"
import ConsoleIcon from "@hugeicons/core-free-icons/ConsoleIcon"
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon"
import CornerDownLeftIcon from "@hugeicons/core-free-icons/CornerDownLeftIcon"
import CpuIcon from "@hugeicons/core-free-icons/CpuIcon"
import CursorInWindowIcon from "@hugeicons/core-free-icons/CursorInWindowIcon"
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon"
import DiscordIcon from "@hugeicons/core-free-icons/DiscordIcon"
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon"
import EyeIcon from "@hugeicons/core-free-icons/EyeIcon"
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon"
import FolderAddIcon from "@hugeicons/core-free-icons/FolderAddIcon"
import GitBranchIcon from "@hugeicons/core-free-icons/GitBranchIcon"
import GitForkIcon from "@hugeicons/core-free-icons/GitForkIcon"
import GithubIcon from "@hugeicons/core-free-icons/GithubIcon"
import GlassesIcon from "@hugeicons/core-free-icons/GlassesIcon"
import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon"
import HierarchyFilesIcon from "@hugeicons/core-free-icons/HierarchyFilesIcon"
import Image01Icon from "@hugeicons/core-free-icons/Image01Icon"
import KeyboardIcon from "@hugeicons/core-free-icons/KeyboardIcon"
import LayoutBottomIcon from "@hugeicons/core-free-icons/LayoutBottomIcon"
import LayoutLeftIcon from "@hugeicons/core-free-icons/LayoutLeftIcon"
import LayoutRightIcon from "@hugeicons/core-free-icons/LayoutRightIcon"
import LayoutThreeRowIcon from "@hugeicons/core-free-icons/LayoutThreeRowIcon"
import LayoutTwoRowIcon from "@hugeicons/core-free-icons/LayoutTwoRowIcon"
import LeftToRightListBulletIcon from "@hugeicons/core-free-icons/LeftToRightListBulletIcon"
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon"
import McpServerIcon from "@hugeicons/core-free-icons/McpServerIcon"
import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon"
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon"
import MinusSignIcon from "@hugeicons/core-free-icons/MinusSignIcon"
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon"
import Note01Icon from "@hugeicons/core-free-icons/Note01Icon"
import NoteEditIcon from "@hugeicons/core-free-icons/NoteEditIcon"
import PanelLeftIcon from "@hugeicons/core-free-icons/PanelLeftIcon"
import PanelRightIcon from "@hugeicons/core-free-icons/PanelRightIcon"
import PencilEdit01Icon from "@hugeicons/core-free-icons/PencilEdit01Icon"
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon"
import PencilIcon from "@hugeicons/core-free-icons/PencilIcon"
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon"
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon"
import SearchList01Icon from "@hugeicons/core-free-icons/SearchList01Icon"
import ServerStack01Icon from "@hugeicons/core-free-icons/ServerStack01Icon"
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon"
import Share01Icon from "@hugeicons/core-free-icons/Share01Icon"
import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon"
import SidebarBottomIcon from "@hugeicons/core-free-icons/SidebarBottomIcon"
import SidebarLeftIcon from "@hugeicons/core-free-icons/SidebarLeftIcon"
import SidebarRightIcon from "@hugeicons/core-free-icons/SidebarRightIcon"
import SlidersHorizontalIcon from "@hugeicons/core-free-icons/SlidersHorizontalIcon"
import SourceCodeIcon from "@hugeicons/core-free-icons/SourceCodeIcon"
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon"
import SquareArrowUpRight02Icon from "@hugeicons/core-free-icons/SquareArrowUpRight02Icon"
import SquareArrowUpRightIcon from "@hugeicons/core-free-icons/SquareArrowUpRightIcon"
import StopIcon from "@hugeicons/core-free-icons/StopIcon"
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon"
import TerminalIcon from "@hugeicons/core-free-icons/TerminalIcon"
import TextAlignRightIcon from "@hugeicons/core-free-icons/TextAlignRightIcon"
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon"
import UndoIcon from "@hugeicons/core-free-icons/UndoIcon"
import UnfoldMoreIcon from "@hugeicons/core-free-icons/UnfoldMoreIcon"

const icons = {
  "align-right": TextAlignRightIcon,
  "arrow-up": ArrowUp01Icon,
  "arrow-left": ArrowLeft01Icon,
  "arrow-right": ArrowRight01Icon,
  archive: Archive02Icon,
  "bubble-5": BubbleChatIcon,
  prompt: CommandLineIcon,
  brain: Brain02Icon,
  fork: GitForkIcon,
  "bullet-list": LeftToRightListBulletIcon,
  "check-small": Tick02Icon,
  "chevron-down": ChevronDownIcon,
  "chevron-left": ChevronLeftIcon,
  "chevron-right": ChevronRightIcon,
  "chevron-grabber-vertical": UnfoldMoreIcon,
  "chevron-double-right": ChevronsRightIcon,
  "circle-x": CancelCircleIcon,
  close: Cancel01Icon,
  "close-small": Cancel01Icon,
  checklist: CheckListIcon,
  console: ConsoleIcon,
  terminal: TerminalIcon,
  "terminal-active": TerminalIcon,
  review: Note01Icon,
  "review-active": Note01Icon,
  expand: ArrowExpand01Icon,
  collapse: ArrowShrink01Icon,
  code: CodeSquareIcon,
  "code-lines": SourceCodeIcon,
  "circle-ban-sign": BanIcon,
  "edit-small-2": PencilEdit02Icon,
  eye: EyeIcon,
  enter: CornerDownLeftIcon,
  folder: Folder01Icon,
  "file-tree": HierarchyFilesIcon,
  "file-tree-active": HierarchyFilesIcon,
  "magnifying-glass": Search01Icon,
  "plus-small": Add01Icon,
  plus: Add01Icon,
  "new-session": NoteEditIcon,
  "new-session-active": NoteEditIcon,
  "pencil-line": PencilIcon,
  mcp: McpServerIcon,
  glasses: GlassesIcon,
  "magnifying-glass-menu": SearchList01Icon,
  "window-cursor": CursorInWindowIcon,
  task: Task01Icon,
  subagent: BotIcon,
  stop: StopIcon,
  status: LayoutTwoRowIcon,
  "status-active": LayoutTwoRowIcon,
  sidebar: SidebarLeftIcon,
  "sidebar-active": SidebarLeftIcon,
  "layout-left": PanelLeftIcon,
  "layout-left-partial": LayoutLeftIcon,
  "layout-left-full": SidebarLeftIcon,
  "layout-right": PanelRightIcon,
  "layout-right-partial": LayoutRightIcon,
  "layout-right-full": SidebarRightIcon,
  "square-arrow-top-right": SquareArrowUpRightIcon,
  "open-file": SquareArrowUpRight02Icon,
  "speech-bubble": Message01Icon,
  comment: Comment01Icon,
  "folder-add-left": FolderAddIcon,
  github: GithubIcon,
  discord: DiscordIcon,
  "layout-bottom": LayoutBottomIcon,
  "layout-bottom-partial": LayoutThreeRowIcon,
  "layout-bottom-full": SidebarBottomIcon,
  "dot-grid": MoreHorizontalIcon,
  "circle-check": CheckmarkCircle01Icon,
  copy: Copy01Icon,
  check: Tick02Icon,
  photo: Image01Icon,
  share: Share01Icon,
  shield: Shield01Icon,
  download: Download01Icon,
  menu: Menu01Icon,
  server: ServerStack01Icon,
  branch: GitBranchIcon,
  edit: PencilEdit01Icon,
  help: HelpCircleIcon,
  "settings-gear": Settings01Icon,
  dash: MinusSignIcon,
  "cloud-upload": CloudUploadIcon,
  trash: Delete02Icon,
  sliders: SlidersHorizontalIcon,
  keyboard: KeyboardIcon,
  selector: UnfoldMoreIcon,
  "arrow-down-to-line": ArrowDownToLineIcon,
  warning: Alert02Icon,
  reset: RefreshIcon,
  link: Link01Icon,
  providers: CpuIcon,
  models: SparklesIcon,
  "arrow-undo-down": UndoIcon,
}

// Hugeicons ships stroke-only artwork, so toggled-on states reuse the base glyph and tint every
// closed shape instead of switching to a filled variant.
const tinted = new Set<keyof typeof icons>([
  "terminal-active",
  "review-active",
  "file-tree-active",
  "new-session-active",
  "status-active",
  "sidebar-active",
])

const spriteID = "forge-icon-sprite"
const symbol = (name: keyof typeof icons) => `forge-icon-${name}`
let spriteInserted = false

function markup(icon: (typeof icons)[keyof typeof icons], fill: boolean) {
  return icon
    .map(([tag, attributes]) => {
      const serialized = Object.entries(attributes)
        .filter(([attribute]) => attribute !== "key")
        .map(([attribute, value]) => `${attribute.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}="${value}"`)
        .join(" ")
      return `<${tag} ${serialized}${fill ? ` fill="currentColor" fill-opacity="0.1"` : ""}/>`
    })
    .join("")
}

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  if (document.getElementById(spriteID)) {
    spriteInserted = true
    return
  }
  const body = document.body as HTMLElement | null
  if (!body) return

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  // batou:ignore BATOU-JSAST-002 -- sprite markup is built only from the compile-time hugeicons path data above, never from runtime input
  svg.innerHTML = Object.entries(icons)
    .map(([name, icon]) => {
      const key = name as keyof typeof icons
      return `<symbol id="${symbol(key)}" viewBox="0 0 24 24">${markup(icon, tinted.has(key))}</symbol>`
    })
    .join("")
  body.insertBefore(svg, body.firstChild)
  spriteInserted = true
}

export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons
  size?: "small" | "normal" | "medium" | "large"
}

export function Icon(props: IconProps) {
  const [local, others] = splitProps(props, ["name", "size", "class", "classList"])
  onMount(ensureSprite)

  return (
    <div data-component="icon" data-size={local.size || "normal"}>
      <svg
        data-slot="icon-svg"
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
        {...others}
      >
        <use href={`#${symbol(local.name)}`} />
      </svg>
    </div>
  )
}
