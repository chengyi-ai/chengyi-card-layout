(function () {
  const HIGHLIGHT_ATTR = 'data-card-highlight';
  const HIGHLIGHT_CLASS = 'editor-highlight';
  const HIGHLIGHT_COLOR = '#FAE985';

  function normalizedColor(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  }

  function isTransparentColor(value) {
    const color = normalizedColor(value);
    return !color
      || color === 'transparent'
      || color === '#0000'
      || color === '#00000000'
      || color === 'rgba(0,0,0,0)'
      || color === 'rgb(0 0 0/0)'
      || color === 'rgba(0 0 0/0)';
  }

  function isLegacyHighlightColor(value) {
    const color = normalizedColor(value);
    return color === '#fae985'
      || color === 'rgb(250,233,133)'
      || color === 'rgba(250,233,133,1)'
      || color === 'rgb(250 233 133)'
      || color === 'rgb(250 233 133/1)'
      || color === 'rgba(250 233 133/1)';
  }

  function isMarked(node) {
    return Boolean(
      node
      && node.nodeType === Node.ELEMENT_NODE
      && node.getAttribute(HIGHLIGHT_ATTR) === 'true'
    );
  }

  function mark(node) {
    node.setAttribute(HIGHLIGHT_ATTR, 'true');
    node.classList.add(HIGHLIGHT_CLASS);
    node.style.removeProperty('background-color');
    if (!node.getAttribute('style')) node.removeAttribute('style');
  }

  function unmark(node) {
    node.removeAttribute(HIGHLIGHT_ATTR);
    node.classList.remove(HIGHLIGHT_CLASS);
    node.style.removeProperty('background-color');
    if (!node.getAttribute('style')) node.removeAttribute('style');
    if (!node.getAttribute('class')) node.removeAttribute('class');
  }

  // 浏览器的富文本命令会产生 rgb/rgba/transparent 等多种写法。
  // 进入业务层前统一转换为 data-card-highlight，透明背景永远不是标记。
  function normalize(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll(`span[${HIGHLIGHT_ATTR}], b[${HIGHLIGHT_ATTR}], strong[${HIGHLIGHT_ATTR}], span.${HIGHLIGHT_CLASS}, b.${HIGHLIGHT_CLASS}, strong.${HIGHLIGHT_CLASS}, span[style], b[style], strong[style]`).forEach((node) => {
      const background = node.style?.backgroundColor || '';
      if (isMarked(node) || isLegacyHighlightColor(background)) {
        mark(node);
      } else if (background || node.classList.contains(HIGHLIGHT_CLASS)) {
        unmark(node);
      }
    });
  }

  function materialize(root) {
    root.querySelectorAll(`[${HIGHLIGHT_ATTR}="true"]`).forEach((node) => {
      node.style.backgroundColor = HIGHLIGHT_COLOR;
      node.removeAttribute(HIGHLIGHT_ATTR);
      node.classList.remove(HIGHLIGHT_CLASS);
      if (!node.getAttribute('class')) node.removeAttribute('class');
    });
  }

  function closestMarked(node, root) {
    let current = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (current && current !== root) {
      if (isMarked(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function selectionIsHighlighted(editor, selection = window.getSelection()) {
    if (!selection || selection.rangeCount === 0) return false;
    if (closestMarked(selection.anchorNode, editor)) return true;
    const range = selection.getRangeAt(0);
    return Array.from(editor.querySelectorAll(`[${HIGHLIGHT_ATTR}="true"]`))
      .some((mark) => {
        try { return range.intersectsNode(mark); }
        catch { return false; }
      });
  }

  function selectionBelongsToEditor(editor, selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer)
      || range.commonAncestorContainer === editor;
  }

  function toggleSelection(editor) {
    const selection = window.getSelection();
    if (!selectionBelongsToEditor(editor, selection)) return false;

    const removeHighlight = selectionIsHighlighted(editor, selection);
    materialize(editor);
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('hiliteColor', false, removeHighlight ? 'transparent' : HIGHLIGHT_COLOR);
    document.execCommand('styleWithCSS', false, false);
    normalize(editor);
    return true;
  }

  window.CreatorHighlight = {
    HIGHLIGHT_ATTR,
    HIGHLIGHT_CLASS,
    HIGHLIGHT_COLOR,
    isLegacyHighlightColor,
    isTransparentColor,
    isMarked,
    normalize,
    selectionIsHighlighted,
    toggleSelection,
  };
})();
