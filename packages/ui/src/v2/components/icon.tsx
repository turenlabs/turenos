import { onMount, type ComponentProps, splitProps } from "solid-js"
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon"
import Archive02Icon from "@hugeicons/core-free-icons/Archive02Icon"
import ArrowExpand01Icon from "@hugeicons/core-free-icons/ArrowExpand01Icon"
import ArrowShrink01Icon from "@hugeicons/core-free-icons/ArrowShrink01Icon"
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon"
import ChevronDownIcon from "@hugeicons/core-free-icons/ChevronDownIcon"
import ComputerIcon from "@hugeicons/core-free-icons/ComputerIcon"
import ContainerIcon from "@hugeicons/core-free-icons/ContainerIcon"
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon"
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon"
import FolderAddIcon from "@hugeicons/core-free-icons/FolderAddIcon"
import GitBranchIcon from "@hugeicons/core-free-icons/GitBranchIcon"
import Grid2X2PlusIcon from "@hugeicons/core-free-icons/Grid2X2PlusIcon"
import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon"
import HierarchyFilesIcon from "@hugeicons/core-free-icons/HierarchyFilesIcon"
import Home05Icon from "@hugeicons/core-free-icons/Home05Icon"
import LayoutTwoRowIcon from "@hugeicons/core-free-icons/LayoutTwoRowIcon"
import MagicWand02Icon from "@hugeicons/core-free-icons/MagicWand02Icon"
import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon"
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon"
import Note01Icon from "@hugeicons/core-free-icons/Note01Icon"
import Package01Icon from "@hugeicons/core-free-icons/Package01Icon"
import PackageAddIcon from "@hugeicons/core-free-icons/PackageAddIcon"
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon"
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon"
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon"
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon"
import Share01Icon from "@hugeicons/core-free-icons/Share01Icon"
import SidebarRightIcon from "@hugeicons/core-free-icons/SidebarRightIcon"
import SlidersHorizontalIcon from "@hugeicons/core-free-icons/SlidersHorizontalIcon"
import SquareArrowUpRightIcon from "@hugeicons/core-free-icons/SquareArrowUpRightIcon"
import TableColumnsSplitIcon from "@hugeicons/core-free-icons/TableColumnsSplitIcon"
import TableRowsSplitIcon from "@hugeicons/core-free-icons/TableRowsSplitIcon"
import TerminalIcon from "@hugeicons/core-free-icons/TerminalIcon"
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon"

const icons = {
  copy: Copy01Icon,
  "dot-grid": MoreHorizontalIcon,
  terminal: TerminalIcon,
  edit: PencilEdit02Icon,
  "folder-add-left": FolderAddIcon,
  folder: Folder01Icon,
  branch: GitBranchIcon,
  "grid-plus": Grid2X2PlusIcon,
  help: HelpCircleIcon,
  home: Home05Icon,
  skills: MagicWand02Icon,
  "sidebar-right": SidebarRightIcon,
  status: LayoutTwoRowIcon,
  "status-active": LayoutTwoRowIcon,
  "magnifying-glass": Search01Icon,
  menu: Menu01Icon,
  plus: Add01Icon,
  "settings-gear": Settings01Icon,
  "chevron-down": ChevronDownIcon,
  collapse: ArrowShrink01Icon,
  check: Tick02Icon,
  monitor: ComputerIcon,
  "workspace-new": PackageAddIcon,
  "workspace-isolated": ContainerIcon,
  workspace: Package01Icon,
  close: Cancel01Icon,
  "xmark-small": Cancel01Icon,
  "outline-xmark": Cancel01Icon,
  "outline-chevron-down": ChevronDownIcon,
  "outline-dots": MoreHorizontalIcon,
  expand: ArrowExpand01Icon,
  filetree: HierarchyFilesIcon,
  split: TableColumnsSplitIcon,
  unified: TableRowsSplitIcon,
  review: Note01Icon,
  "outline-sliders": SlidersHorizontalIcon,
  "outline-copy": Copy01Icon,
  "outline-square-arrow": SquareArrowUpRightIcon,
  "outline-share": Share01Icon,
  reset: RefreshIcon,
  "outline-reset": RefreshIcon,
  archive: Archive02Icon,
}

// Hugeicons ships stroke-only artwork, so toggled-on states reuse the base glyph and tint every
// closed shape instead of switching to a filled variant.
const tinted = new Set<keyof typeof icons>(["status-active"])

const spriteID = "forge-v2-icon-sprite"
const symbol = (name: keyof typeof icons) => `forge-v2-icon-${name}`
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
  document.body.insertBefore(svg, document.body.firstChild)
  spriteInserted = true
}

export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons
  size?: "small" | "normal" | "large"
}

export function Icon(props: IconProps) {
  const [split, rest] = splitProps(props, ["name", "size"])
  const iconName = () => (icons[split.name as keyof typeof icons] ? (split.name as keyof typeof icons) : "plus")
  const pixelSize = split.size === "small" ? 14 : split.size === "large" ? 20 : 16
  onMount(ensureSprite)

  return (
    <svg
      {...rest}
      data-slot="icon-svg"
      width={pixelSize}
      height={pixelSize}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <use href={`#${symbol(iconName())}`} />
    </svg>
  )
}
