export function animationKeyframes(values: readonly (number | string)[], duration: number) {
  return values.slice(1).map((value, index) => ({
    from: values[index]!,
    to: value,
    duration: duration / (values.length - 1),
    ease: "linear" as const,
  }))
}
