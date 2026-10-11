// ===== 内容解析器 =====
class ContentParser {
  constructor(editor) {
    this.editor = editor;
  }

  parse() {
    const elements = [];
    const editorEl = this.editor.editor;

    for (const child of editorEl.childNodes) {
      this._walk(child, elements);
    }

    const merged = this._mergeAdjacentText(elements);
    return this._deduplicateEmptyLines(merged);
  }

  _walk(node, elements) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (/[\r\n]/.test(text)) {
        text.split(/\r\n?|\n/).forEach((line) => {
          if (line.trim()) {
            elements.push({ type: 'p', html: this._textToHTML(node, line) });
            elements.push({ type: 'blockbreak' });
          } else {
            elements.push({ type: 'empty' });
          }
        });
      } else if (text.trim()) {
        elements.push({ type: 'p', html: this._textToHTML(node) });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (node.classList && node.classList.contains('page-break-marker')) {
        elements.push({ type: 'pagebreak' });
      } else if (tag === 'div' && node.dataset.cardCollage === '1' && node.classList.contains('image-collage')) {
        const api = collageLayoutAPI();
        const itemNodes = Array.from(node.children).filter((child) => child.classList.contains('collage-item'));
        const items = normalizeCollageDOMEntries(itemNodes).map(({ node: itemNode, model }) => {
          const img = itemNode?.querySelector(':scope > img');
          if (!img || img.dataset.mediaKind === 'video') return null;
          return {
            ...model,
            src: img.src,
            frame: normalizeImageFrame(img.dataset.frame),
          };
        }).filter(Boolean);
        if (items.length > 0) {
          elements.push({ type: 'collage', height: api.normalizeHeight(node.dataset.collageHeight), items });
        }
      } else if (tag === 'img') {
        elements.push({
          type: 'img',
          src: node.src,
          width: node.style.width || '100%',
          frame: normalizeImageFrame(node.dataset.frame),
          media: mediaMetadataFromNode(node),
        });
      } else if (tag === 'br' && node.dataset.collageCaret === '1') {
        return;
      } else if (tag === 'br') {
        elements.push({ type: 'empty' });
      } else if (tag === 'div' || tag === 'p') {
        if (node.childNodes.length === 0 || (node.childNodes.length === 1 && node.firstChild.tagName === 'BR')) {
          elements.push({ type: 'empty' });
        } else {
          elements.push({ type: 'blockbreak' });
          for (const child of node.childNodes) this._walk(child, elements);
          elements.push({ type: 'blockbreak' });
        }
      } else {
        for (const child of node.childNodes) this._walk(child, elements);
      }
    }
  }

  // 向上扫描祖先，还原加粗 / 荧光标记（两者可叠加）
  _textToHTML(textNode, textOverride) {
    let bold = false;
    let highlight = false;
    const root = this.editor.editor;
    let node = textNode.parentElement;
    while (node && node !== root) {
      if (node.tagName === 'B' || node.tagName === 'STRONG') bold = true;
      if (window.CreatorHighlight?.isMarked(node)
        || window.CreatorHighlight?.isLegacyHighlightColor(node.style?.backgroundColor)) highlight = true;
      node = node.parentElement;
    }
    let html = escapeHTML(textOverride ?? textNode.textContent);
    if (bold) html = '<b>' + html + '</b>';
    if (highlight) html = '<span class="hl">' + html + '</span>';
    return html;
  }

  _mergeAdjacentText(elements) {
    const merged = [];
    let textBuffer = '';
    for (const el of elements) {
      if (el.type === 'p') {
        textBuffer += el.html;
      } else if (el.type === 'blockbreak') {
        if (textBuffer.trim()) merged.push({ type: 'p', html: textBuffer });
        textBuffer = '';
      } else {
        if (textBuffer.trim()) merged.push({ type: 'p', html: textBuffer });
        textBuffer = '';
        merged.push(el);
      }
    }
    if (textBuffer.trim()) merged.push({ type: 'p', html: textBuffer });
    return merged;
  }

  _deduplicateEmptyLines(elements) {
    const deduped = [];
    for (const el of elements) {
      if (el.type === 'empty' && deduped.length > 0 && deduped[deduped.length - 1].type === 'empty') {
        continue;
      }
      deduped.push(el);
    }
    while (deduped.length > 0 && deduped[0].type === 'empty') deduped.shift();
    while (deduped.length > 0 && deduped[deduped.length - 1].type === 'empty') deduped.pop();
    return deduped;
  }
}

function shouldCenterPageContent(elements, usedRatio) {
  const containsCollage = Array.isArray(elements)
    && elements.some((element) => element?.type === 'collage');
  return Number(usedRatio) < 0.85 && !containsCollage;
}

// ===== 分页引擎 =====
class PaginationEngine {
  constructor(renderContainer) {
    this.container = renderContainer;
  }

  paginate(elements, buildAuthorHTML) {
    this.container.innerHTML = '';
    const pages = [];
    let currentPageEls = [];
    let isFirstPage = true;

    let { card: mc, body: mb } = this._createMeasureCard(true, buildAuthorHTML);

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];

      // 手动分页符：强制结束当前页，剩余空白保留
      if (el.type === 'pagebreak') {
        if (currentPageEls.length > 0) {
          pages.push({ elements: [...currentPageEls], isFirst: isFirstPage, centerContent: false });
          currentPageEls = [];
          isFirstPage = false;
          this.container.removeChild(mc);
          ({ card: mc, body: mb } = this._createMeasureCard(false, buildAuthorHTML));
        }
        continue;
      }

      // 每页开头不放空行
      if (el.type === 'empty' && currentPageEls.length === 0) continue;

      const domEl = Renderer.createDomElement(el);
      mb.appendChild(domEl);
      const available = this._getAvailable(mc, mb);

      if (mb.scrollHeight > available) {
        mb.removeChild(domEl);

        // 尝试拆分长段落
        if (el.type === 'p') {
          const split = this._splitParagraph(el.html, mc, mb);
          if (split && split.first.trim()) {
            const firstP = document.createElement('p');
            firstP.innerHTML = split.first;
            mb.appendChild(firstP);
            currentPageEls.push({ type: 'p', html: split.first });

            pages.push({ elements: [...currentPageEls], isFirst: isFirstPage, centerContent: false });
            currentPageEls = [];
            isFirstPage = false;
            this.container.removeChild(mc);
            ({ card: mc, body: mb } = this._createMeasureCard(false, buildAuthorHTML));

            if (split.rest.trim()) {
              elements.splice(i + 1, 0, { type: 'p', html: split.rest });
            }
            continue;
          }
        }

        // 无法拆分：整个推到下一页，计算当前页留白比例
        if (currentPageEls.length > 0) {
          const available = this._getAvailable(mc, mb);
          const usedRatio = this._getContentHeight(mb) / available;
          pages.push({
            elements: [...currentPageEls],
            isFirst: isFirstPage,
            centerContent: shouldCenterPageContent(currentPageEls, usedRatio),
          });
          currentPageEls = [];
          isFirstPage = false;
          this.container.removeChild(mc);
          ({ card: mc, body: mb } = this._createMeasureCard(false, buildAuthorHTML));
        }
        mb.appendChild(Renderer.createDomElement(el));
        currentPageEls.push(el);
      } else {
        currentPageEls.push(el);
      }
    }

    if (currentPageEls.length > 0) {
      const available = this._getAvailable(mc, mb);
      const usedRatio = this._getContentHeight(mb) / available;
      pages.push({
        elements: [...currentPageEls],
        isFirst: isFirstPage,
        centerContent: shouldCenterPageContent(currentPageEls, usedRatio),
      });
    }
    this.container.innerHTML = '';
    if (pages.length === 0) pages.push({ elements: [], isFirst: true, centerContent: false });

    // 后处理：把每页开头的"不能行首"标点移到上一页结尾
    this._fixLeadingPunctuation(pages);
    return pages;
  }

  // 把每页开头的不能行首标点移到上一页结尾
  _fixLeadingPunctuation(pages) {
    // 中文 + 英文常见的不能行首标点
    const noLineStart = /^[。，、；：？！」』）】》〉…—.,?!:;)\]}'"]+/;

    for (let i = 1; i < pages.length; i++) {
      const page = pages[i];
      if (!page.elements || page.elements.length === 0) continue;
      const first = page.elements[0];
      if (first.type !== 'p') continue;

      // 提取段落开头的纯文本
      const div = document.createElement('div');
      div.innerHTML = first.html;
      const text = div.textContent;
      const match = text.match(noLineStart);
      if (!match) continue;

      const punctLen = match[0].length;

      // 找上一页最后一个 p 元素
      const prevPage = pages[i - 1];
      let lastPIdx = -1;
      for (let j = prevPage.elements.length - 1; j >= 0; j--) {
        if (prevPage.elements[j].type === 'p') { lastPIdx = j; break; }
      }
      if (lastPIdx === -1) continue;

      // 把开头标点剪切到上一页末尾
      const punctHtml = this._truncateHTML(first.html, punctLen);
      const restHtml = this._truncateHTMLAfter(first.html, punctLen);

      prevPage.elements[lastPIdx] = {
        type: 'p',
        html: prevPage.elements[lastPIdx].html + punctHtml,
      };
      first.html = restHtml;

      // 如果当前段落变空，移除它
      if (!first.html.trim()) {
        page.elements.shift();
      }
    }
  }

  _createMeasureCard(withAuthor, buildAuthorHTML) {
    const S = STYLES;
    const card = document.createElement('div');
    card.className = 'card-page';
    card.style.cssText = `width:${CARD_W}px;height:${CARD_H}px;padding:${S.paddingY}px ${S.paddingX}px;background:${S.bgColor};position:absolute;left:0;top:0;`;
    if (withAuthor) card.innerHTML = buildAuthorHTML();
    const body = document.createElement('div');
    body.className = 'card-body';
    body.style.cssText = `font-size:${S.fontSize}px;line-height:${S.lineHeight};color:${S.textColor};`;
    card.appendChild(body);
    this.container.appendChild(card);
    return { card, body };
  }

  _getAvailable(card, body) {
    const cardStyle = getComputedStyle(card);
    const paddingTop = parseFloat(cardStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(cardStyle.paddingBottom) || 0;
    const leadingContent = body.offsetTop - card.offsetTop - paddingTop;
    return CARD_H - paddingTop - paddingBottom - leadingContent;
  }

  // 计算 body 内子元素的实际内容高度（不受 flex:1 撑满影响）
  _getContentHeight(body) {
    let height = 0;
    for (const child of body.children) {
      const style = getComputedStyle(child);
      height += child.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    }
    return height;
  }

  _splitParagraph(html, card, body) {
    const testP = document.createElement('p');
    testP.innerHTML = html;
    body.appendChild(testP);
    const available = this._getAvailable(card, body);

    if (body.scrollHeight <= available) {
      body.removeChild(testP);
      return null;
    }

    const plainText = testP.textContent;
    body.removeChild(testP);

    // 二分查找能放下的最大字符数
    let lo = 1, hi = plainText.length, bestSplit = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      testP.innerHTML = this._truncateHTML(html, mid);
      body.appendChild(testP);
      if (body.scrollHeight <= available) {
        bestSplit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
      body.removeChild(testP);
    }

    if (bestSplit === 0) return null;

    const remaining = plainText.substring(bestSplit);

    // 英文单词/数字中间断开：回退到上一个单词边界（空格或标点）
    const before = plainText.substring(0, bestSplit);
    const lastChar = before[before.length - 1];
    const nextChar = remaining[0];
    if (lastChar && nextChar && /[a-zA-Z0-9]/.test(lastChar) && /[a-zA-Z0-9]/.test(nextChar)) {
      const boundary = before.search(/[\s\p{P}\p{S}](?=[^\s\p{P}\p{S}]*$)/u);
      if (boundary > 0) {
        bestSplit = boundary + 1;
      }
    }

    return {
      first: this._truncateHTML(html, bestSplit),
      rest: this._truncateHTMLAfter(html, bestSplit),
    };
  }

  // 截取 HTML 的前 N 个纯文本字符（保留标签结构）
  _truncateHTML(html, maxChars) {
    const div = document.createElement('div');
    div.innerHTML = html;
    let count = 0;
    function walk(node) {
      if (count >= maxChars) { node.textContent = ''; return; }
      if (node.nodeType === Node.TEXT_NODE) {
        const remaining = maxChars - count;
        if (node.textContent.length > remaining) {
          node.textContent = node.textContent.substring(0, remaining);
          count = maxChars;
        } else {
          count += node.textContent.length;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    }
    walk(div);
    return div.innerHTML;
  }

  // 截取 HTML 的第 N 个纯文本字符之后的部分
  _truncateHTMLAfter(html, skipChars) {
    const div = document.createElement('div');
    div.innerHTML = html;
    let count = 0;
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const remaining = skipChars - count;
        if (remaining >= node.textContent.length) {
          count += node.textContent.length;
          node.textContent = '';
        } else if (remaining > 0) {
          node.textContent = node.textContent.substring(remaining);
          count = skipChars;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    }
    walk(div);
    return div.innerHTML.replace(/<b><\/b>/g, '').replace(/<strong><\/strong>/g, '').replace(/<span[^>]*><\/span>/g, '');
  }
}
