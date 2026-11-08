/** The nearest vertical scrolling ancestor owns detail/list navigation, not necessarily Window. */
export function catalogueScrollContainer(element: HTMLElement): HTMLElement | Window {
  for (let parent: HTMLElement | null = element; parent && parent !== document.body; parent = parent.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return window;
}

export function catalogueScrollTop(container: HTMLElement | Window) {
  return container === window ? window.scrollY : (container as HTMLElement).scrollTop;
}

export function catalogueElementTop(element: HTMLElement, container: HTMLElement | Window) {
  if (element === container) return 0;
  const viewportTop = container === window ? 0 : (container as HTMLElement).getBoundingClientRect().top + (container as HTMLElement).clientTop;
  return catalogueScrollTop(container) + element.getBoundingClientRect().top - viewportTop;
}

export function scrollCatalogueTo(element: HTMLElement, behavior: ScrollBehavior = "instant") {
  const container = catalogueScrollContainer(element);
  container.scrollTo({ top: catalogueElementTop(element, container), behavior });
}
