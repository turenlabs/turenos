export function disableNativeMotion(root: Element) {
  const work = { rules: 0 }
  root.querySelectorAll("animate, animateMotion, animateTransform, set, marquee").forEach((element) => element.remove())
  ;[root, ...root.querySelectorAll("*")].forEach((element) => {
    if (!("style" in element)) return
    const style = (element as HTMLElement | SVGElement).style
    style.setProperty("animation", "none", "important")
    style.setProperty("transition", "none", "important")
  })

  function disable(rules: CSSRuleList, depth: number) {
    work.rules += rules.length
    if (depth > 32 || work.rules > 10000) throw new Error("This scene exceeds the style limits.")
    Array.from(rules).forEach((rule) => {
      if ("style" in rule) {
        const style = (rule as CSSStyleRule).style
        style.setProperty("animation", "none", "important")
        style.setProperty("transition", "none", "important")
      }
      if ("cssRules" in rule) disable((rule as CSSGroupingRule).cssRules, depth + 1)
    })
  }

  try {
    Array.from(root.ownerDocument.styleSheets).forEach((sheet) => disable(sheet.cssRules, 0))
  } catch (error) {
    // Remove every agent stylesheet if its CSSOM cannot be bounded or inspected.
    root.querySelectorAll("style").forEach((element) => element.remove())
    throw error
  }
  root.ownerDocument.getAnimations?.().forEach((animation) => animation.cancel())
}
