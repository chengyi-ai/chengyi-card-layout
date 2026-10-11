'use strict';

// ===== 编辑器：视频与实况 =====
// 视频插入、封面生成与片段时间轴，挂到 EditorManager 原型上。
Object.assign(EditorManager.prototype, {
  async _getTimelineHelpers() {
    if (window.ChengYiVideoTimeline) return window.ChengYiVideoTimeline;
    if (!this.timelineHelpersPromise) {
      this.timelineHelpersPromise = import(CARD_VIDEO_TIMELINE_URL).then((module) => {
        const helpers = module.default || window.ChengYiVideoTimeline;
        if (!helpers?.clampTimelineSelection || !helpers?.selectionFromHandlePosition) {
          throw new Error('视频时间轴组件不完整');
        }
        return helpers;
      }).catch((error) => {
        this.timelineHelpersPromise = null;
        throw error;
      });
    }
    return this.timelineHelpersPromise;
  },

  _clampTimelineSelection(metadata, overrides = {}) {
    const input = {
      sourceDuration: metadata.sourceDuration,
      startSeconds: overrides.startSeconds ?? metadata.startSeconds,
      durationSeconds: overrides.durationSeconds ?? metadata.durationSeconds,
    };
    const helpers = window.ChengYiVideoTimeline;
    if (helpers?.clampTimelineSelection) return helpers.clampTimelineSelection(input);

    // module script 尚未完成时的短暂回退；保持旧草稿与 3/5 秒快捷值可用。
    const rawSourceDuration = Math.max(0, Number(input.sourceDuration) || 0);
    const sourceDuration = supportsFiveSecondSelection(rawSourceDuration)
      ? Math.max(5, Math.floor(rawSourceDuration * 10) / 10)
      : Math.floor(rawSourceDuration * 10) / 10;
    if (sourceDuration < 3) throw new RangeError('源视频不足 3 秒，无法选择有效片段');
    let durationSeconds = normalizeVideoDuration(input.durationSeconds);
    if (!supportsFiveSecondSelection(rawSourceDuration) && durationSeconds === 5) durationSeconds = 3;
    durationSeconds = Math.min(sourceDuration, durationSeconds);
    const maxStart = Math.floor(Math.max(0, sourceDuration - durationSeconds) * 10) / 10;
    const startSeconds = Math.min(normalizeVideoStart(input.startSeconds), maxStart);
    return {
      startSeconds,
      endSeconds: Math.round((startSeconds + durationSeconds) * 10) / 10,
      durationSeconds,
      maxStart,
    };
  },

  _formatTimelineTime(seconds) {
    if (window.ChengYiVideoTimeline?.formatTime) return window.ChengYiVideoTimeline.formatTime(seconds);
    const value = Math.max(0, Math.round((Number(seconds) || 0) * 10) / 10);
    return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;
  },

  _syncDurationSelect(durationSeconds, sourceDuration) {
    const select = document.getElementById('mediaDuration');
    if (!select) return;
    const fiveSecondOption = select.querySelector('option[value="5"]');
    if (fiveSecondOption) fiveSecondOption.disabled = sourceDuration > 0 && !supportsFiveSecondSelection(sourceDuration);
    select.value = String(durationSeconds);
  },

  _renderTimelineSelection(selection, sourceDuration = this.timelineSourceDuration) {
    if (!selection || !(sourceDuration > 0)) return;
    this.timelineSelection = selection;
    this.timelineSourceDuration = sourceDuration;
    const startRatio = Math.max(0, Math.min(1, selection.startSeconds / sourceDuration));
    const endRatio = Math.max(startRatio, Math.min(1, selection.endSeconds / sourceDuration));
    const startPercent = startRatio * 100;
    const endPercent = endRatio * 100;
    const selectionEl = document.getElementById('mediaTimelineSelection');
    const timelineTrack = document.getElementById('mediaTimelineTrack');
    const shadeStart = document.getElementById('mediaTimelineShadeStart');
    const shadeEnd = document.getElementById('mediaTimelineShadeEnd');
    if (selectionEl) {
      // 命中区至少 44px；::before 仍按准确起止位置绘制，不改变视觉时长。
      const trackWidth = timelineTrack?.clientWidth || 320;
      const visualWidth = trackWidth * (endRatio - startRatio);
      const extraWidth = Math.max(16, 44 - visualWidth);
      const visualLeft = trackWidth * startRatio;
      const visualRightSpace = trackWidth * (1 - endRatio);
      let hitLeft = Math.min(extraWidth / 2, visualLeft);
      let hitRight = Math.min(extraWidth - hitLeft, visualRightSpace);
      hitLeft = Math.min(extraWidth - hitRight, visualLeft);
      selectionEl.style.setProperty('--timeline-hit-left', `${hitLeft}px`);
      selectionEl.style.setProperty('--timeline-hit-right', `${hitRight}px`);
      selectionEl.style.left = `calc(${startPercent}% - ${hitLeft}px)`;
      selectionEl.style.width = `calc(${Math.max(0, endPercent - startPercent)}% + ${hitLeft + hitRight}px)`;
      selectionEl.setAttribute('aria-valuemin', '0');
      selectionEl.setAttribute('aria-valuemax', String(selection.maxStart));
      selectionEl.setAttribute('aria-valuenow', String(selection.startSeconds));
      selectionEl.setAttribute(
        'aria-valuetext',
        `${this._formatTimelineTime(selection.startSeconds)} 到 ${this._formatTimelineTime(selection.endSeconds)}`,
      );
    }
    if (shadeStart) shadeStart.style.width = `${startPercent}%`;
    if (shadeEnd) shadeEnd.style.width = `${Math.max(0, 100 - endPercent)}%`;

    const startLabel = document.getElementById('mediaTimelineStartLabel');
    const endLabel = document.getElementById('mediaTimelineEndLabel');
    const durationLabel = document.getElementById('mediaTimelineDurationLabel');
    if (startLabel) startLabel.textContent = this._formatTimelineTime(selection.startSeconds);
    if (endLabel) endLabel.textContent = this._formatTimelineTime(selection.endSeconds);
    if (durationLabel) durationLabel.textContent = `${selection.durationSeconds.toFixed(1)} 秒`;
    const startInput = document.getElementById('mediaStart');
    if (startInput) {
      startInput.value = String(selection.startSeconds);
      startInput.max = String(selection.maxStart);
    }
    this._syncDurationSelect(selection.durationSeconds, sourceDuration);

  },

  _setTimelineLoading(message = '', hidden = false) {
    const loading = document.getElementById('mediaTimelineLoading');
    if (!loading) return;
    loading.textContent = message;
    loading.hidden = hidden;
  },

  _cleanupVideoTimeline(options = {}) {
    this.timelineSession += 1;
    this.timelineDrag = null;
    this.timelineSelection = null;
    this.timelineSourceDuration = 0;
    this.timelineMediaKey = '';
    if (this.timelinePreviewFrame) cancelAnimationFrame(this.timelinePreviewFrame);
    this.timelinePreviewFrame = 0;
    const video = document.getElementById('mediaTimelineVideo');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.removeAttribute('poster');
      video.load();
    }
    if (this.timelineObjectURL) URL.revokeObjectURL(this.timelineObjectURL);
    this.timelineObjectURL = '';
    const frames = document.getElementById('mediaTimelineFrames');
    if (frames) {
      frames.replaceChildren();
      frames.classList.remove('ready');
    }
    const timeline = document.getElementById('mediaTimeline');
    if (timeline && options.hide !== false) timeline.hidden = true;
  },

  _waitForTimelineVideo(video, eventName, timeoutMessage) {
    if ((eventName === 'loadedmetadata' && video.readyState >= 1)
      || (eventName === 'loadeddata' && video.readyState >= 2)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(timeoutMessage)), 12_000);
      const onReady = () => finish();
      const onError = () => finish(new Error('视频画面无法解码'));
      const finish = (error) => {
        clearTimeout(timeout);
        video.removeEventListener(eventName, onReady);
        video.removeEventListener('error', onError);
        if (error) reject(error);
        else resolve();
      };
      video.addEventListener(eventName, onReady, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
  },

  _seekTimelineVideo(video, seconds) {
    const duration = Math.max(0, Number(video.duration) || this.timelineSourceDuration);
    const target = Math.max(0, Math.min(Math.max(0, duration - 0.04), Number(seconds) || 0));
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.035) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('定位视频画面超时')), 5_000);
      const onSeeked = () => finish();
      const onError = () => finish(new Error('定位视频画面失败'));
      const finish = (error) => {
        clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        if (error) reject(error);
        else resolve();
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.currentTime = target;
    });
  },

  _renderTimelineFrames(frameSources) {
    const frames = document.getElementById('mediaTimelineFrames');
    if (!frames) return;
    const fragment = document.createDocumentFragment();
    frameSources.forEach((source) => {
      const img = document.createElement('img');
      img.src = source;
      img.alt = '';
      img.draggable = false;
      fragment.appendChild(img);
    });
    frames.replaceChildren(fragment);
    frames.classList.toggle('ready', frameSources.length > 0);
  },

  async _generateTimelineFrames(cacheKey, session) {
    const cached = this.timelineFrameCache.get(cacheKey);
    if (cached?.length) {
      this._renderTimelineFrames(cached);
      return;
    }
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = this.timelineObjectURL;
    video.load();
    try {
      await this._waitForTimelineVideo(video, 'loadeddata', '读取视频画面超时');
      const frameCount = 8;
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法生成视频缩略图');
      const sources = [];
      for (let index = 0; index < frameCount; index += 1) {
        if (session !== this.timelineSession) return;
        const time = frameCount === 1 ? 0 : (index / (frameCount - 1)) * this.timelineSourceDuration;
        await this._seekTimelineVideo(video, time);
        const sourceWidth = Math.max(1, video.videoWidth);
        const sourceHeight = Math.max(1, video.videoHeight);
        const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
        const drawWidth = sourceWidth * scale;
        const drawHeight = sourceHeight * scale;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
        sources.push(canvas.toDataURL('image/jpeg', 0.7));
      }
      if (session !== this.timelineSession) return;
      this.timelineFrameCache.set(cacheKey, sources);
      while (this.timelineFrameCache.size > 6) this.timelineFrameCache.delete(this.timelineFrameCache.keys().next().value);
      this._renderTimelineFrames(sources);
    } finally {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  },

  _previewTimelineAt(seconds) {
    const sourceDuration = this.timelineSourceDuration;
    if (!(sourceDuration > 0)) return;
    const requestedTime = Math.max(0, Math.min(sourceDuration, Number(seconds) || 0));
    const label = document.getElementById('mediaTimelinePreviewTime');
    if (label) label.textContent = this._formatTimelineTime(requestedTime);
    const playhead = document.getElementById('mediaTimelinePlayhead');
    if (playhead) playhead.style.left = `${(requestedTime / sourceDuration) * 100}%`;
    const video = document.getElementById('mediaTimelineVideo');
    if (!video?.src || video.readyState < 1) return;
    if (this.timelinePreviewFrame) cancelAnimationFrame(this.timelinePreviewFrame);
    this.timelinePreviewFrame = requestAnimationFrame(() => {
      this.timelinePreviewFrame = 0;
      const target = Math.min(Math.max(0, sourceDuration - 0.04), requestedTime);
      if (Math.abs(video.currentTime - target) > 0.035) video.currentTime = target;
    });
  },

  async _prepareVideoTimeline(img, metadata) {
    const timeline = document.getElementById('mediaTimeline');
    if (!timeline) return;
    timeline.hidden = false;
    const accountId = this.app.accountId;
    const draftId = metadata.sourceDraftId || this.app.getActiveDraftId();
    const cacheKey = `${accountId}/${draftId}/${metadata.id}/${metadata.sourceDuration}`;
    if (cacheKey === this.timelineMediaKey && this.timelineObjectURL) {
      const selection = this._clampTimelineSelection(metadata);
      this._renderTimelineSelection(selection, metadata.sourceDuration);
      this._previewTimelineAt(selection.startSeconds);
      return;
    }

    this._cleanupVideoTimeline({ hide: false });
    const session = this.timelineSession;
    this.timelineMediaKey = cacheKey;
    this.timelineSourceDuration = metadata.sourceDuration;
    this._setTimelineLoading('正在读取视频画面…');
    try {
      await this._getTimelineHelpers();
      const store = await getCardMediaStore();
      const asset = await store.get({ accountId, draftId, mediaId: metadata.id, role: CARD_MEDIA_SOURCE_ROLE });
      if (session !== this.timelineSession) return;
      if (!asset?.blob) throw new Error('原视频不在当前设备，请恢复包含素材的备份');
      const video = document.getElementById('mediaTimelineVideo');
      if (!video) return;
      this.timelineObjectURL = URL.createObjectURL(asset.blob);
      video.poster = img.currentSrc || img.src;
      video.src = this.timelineObjectURL;
      video.load();
      await this._waitForTimelineVideo(video, 'loadedmetadata', '读取视频信息超时');
      await this._waitForTimelineVideo(video, 'loadeddata', '读取视频画面超时');
      if (session !== this.timelineSession) return;
      const decodedDuration = Number(video.duration) || metadata.sourceDuration;
      this.timelineSourceDuration = Math.min(metadata.sourceDuration || decodedDuration, decodedDuration);
      const timelineMetadata = { ...metadata, sourceDuration: this.timelineSourceDuration };
      const selection = this._clampTimelineSelection(timelineMetadata);
      const repaired = selection.startSeconds !== metadata.startSeconds
        || selection.durationSeconds !== metadata.durationSeconds;
      if (repaired) {
        applyMediaMetadataToImage(img, {
          ...metadata,
          startSeconds: selection.startSeconds,
          durationSeconds: selection.durationSeconds,
        });
        this.app.saveDraft();
      }
      this._renderTimelineSelection(selection, this.timelineSourceDuration);
      this._previewTimelineAt(selection.startSeconds);
      await this._generateTimelineFrames(cacheKey, session);
      if (session !== this.timelineSession) return;
      this._previewTimelineAt(selection.startSeconds);
      this._setTimelineLoading('', true);
    } catch (error) {
      if (session !== this.timelineSession) return;
      // 失败不能把旧 Object URL 与 cache key 留在“已加载”状态，否则下一次无法重试。
      this._cleanupVideoTimeline({ hide: false });
      this.timelineSourceDuration = metadata.sourceDuration;
      try {
        this._renderTimelineSelection(this._clampTimelineSelection(metadata), metadata.sourceDuration);
      } catch (_) {
        // 插入流程已拒绝不足 3 秒的视频；这里只保留原始错误提示。
      }
      this._setTimelineLoading(`${error.message || '无法读取视频时间轴'} · 再次点击视频可重试`);
    }
  },

  _timelineRatioFromEvent(event) {
    const track = document.getElementById('mediaTimelineTrack');
    const rect = track?.getBoundingClientRect();
    if (!rect?.width) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  },

  _selectionForTimelinePointer(mode, ratio) {
    if (!this.timelineSelection || !(this.timelineSourceDuration > 0)) return null;
    const helpers = window.ChengYiVideoTimeline;
    if (!helpers) return null;
    if (mode === 'start' || mode === 'end') {
      return helpers.selectionFromHandlePosition({
        sourceDuration: this.timelineSourceDuration,
        startSeconds: this.timelineSelection.startSeconds,
        durationSeconds: this.timelineSelection.durationSeconds,
        handle: mode,
        positionRatio: ratio,
      });
    }
    if (mode === 'move' && this.timelineDrag) {
      const delta = (ratio - this.timelineDrag.startRatio) * this.timelineSourceDuration;
      return helpers.clampTimelineSelection({
        sourceDuration: this.timelineSourceDuration,
        startSeconds: this.timelineDrag.initial.startSeconds + delta,
        durationSeconds: this.timelineDrag.initial.durationSeconds,
      });
    }
    return null;
  },

  _onTimelinePointerDown(event) {
    if (event.button !== 0 || !this.timelineSelection || !(this.timelineSourceDuration > 0)) return;
    const track = document.getElementById('mediaTimelineTrack');
    const control = event.target.closest('[data-timeline-handle]');
    const mode = control?.dataset.timelineHandle || 'preview';
    const ratio = this._timelineRatioFromEvent(event);
    if (mode === 'preview') {
      this._previewTimelineAt(ratio * this.timelineSourceDuration);
      // 触控背景保留浏览器的纵向滚动；鼠标仍可按住胶片条连续查看画面。
      if (event.pointerType !== 'mouse') return;
    }
    this.timelineDrag = {
      pointerId: event.pointerId,
      mode,
      startRatio: ratio,
      initial: { ...this.timelineSelection },
      moved: false,
      active: event.pointerType === 'mouse',
      pointerType: event.pointerType,
      originX: event.clientX,
      originY: event.clientY,
    };
    if (this.timelineDrag.active) track.setPointerCapture?.(event.pointerId);
    if (mode !== 'preview' && this.timelineDrag.active) event.preventDefault();
    if (mode !== 'preview') this._previewTimelineAt(this.timelineSelection.startSeconds);
  },

  _onTimelinePointerMove(event) {
    const drag = this.timelineDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      const deltaX = Math.abs(event.clientX - drag.originX);
      const deltaY = Math.abs(event.clientY - drag.originY);
      if (Math.max(deltaX, deltaY) < 6) return;
      if (deltaY > deltaX) {
        this.timelineDrag = null;
        return;
      }
      drag.active = true;
      document.getElementById('mediaTimelineTrack')?.setPointerCapture?.(event.pointerId);
    }
    const ratio = this._timelineRatioFromEvent(event);
    drag.moved = drag.moved || Math.abs(ratio - drag.startRatio) > 0.002;
    if (drag.mode === 'preview') {
      this._previewTimelineAt(ratio * this.timelineSourceDuration);
      return;
    }
    event.preventDefault();
    const selection = this._selectionForTimelinePointer(drag.mode, ratio);
    if (!selection) return;
    this._renderTimelineSelection(selection);
    this._previewTimelineAt(drag.mode === 'end' ? selection.endSeconds : selection.startSeconds);
  },

  _onTimelinePointerEnd(event) {
    const drag = this.timelineDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const track = document.getElementById('mediaTimelineTrack');
    if (track.hasPointerCapture?.(event.pointerId)) track.releasePointerCapture(event.pointerId);
    this.timelineDrag = null;
    if (drag.active && drag.mode !== 'preview' && this.timelineSelection) this._commitTimelineSelection(this.timelineSelection);
  },

  _onTimelineKeydown(event) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !this.timelineSelection) return;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const step = (event.shiftKey ? 1 : 0.1) * direction;
    const mode = event.target.closest('[data-timeline-handle]')?.dataset.timelineHandle || 'move';
    const helpers = window.ChengYiVideoTimeline;
    if (!helpers) return;
    let selection;
    if (mode === 'start' || mode === 'end') {
      const seconds = (mode === 'start' ? this.timelineSelection.startSeconds : this.timelineSelection.endSeconds) + step;
      selection = helpers.selectionFromHandlePosition({
        sourceDuration: this.timelineSourceDuration,
        startSeconds: this.timelineSelection.startSeconds,
        durationSeconds: this.timelineSelection.durationSeconds,
        handle: mode,
        positionRatio: seconds / this.timelineSourceDuration,
      });
    } else {
      selection = helpers.clampTimelineSelection({
        sourceDuration: this.timelineSourceDuration,
        startSeconds: this.timelineSelection.startSeconds + step,
        durationSeconds: this.timelineSelection.durationSeconds,
      });
    }
    event.preventDefault();
    this._renderTimelineSelection(selection);
    this._previewTimelineAt(mode === 'end' ? selection.endSeconds : selection.startSeconds);
    this._commitTimelineSelection(selection);
  },

  _commitTimelineSelection(selection) {
    if (!this.selectedImg || !selection) return;
    const metadata = mediaMetadataFromNode(this.selectedImg);
    if (!metadata) return;
    applyMediaMetadataToImage(this.selectedImg, {
      ...metadata,
      startSeconds: selection.startSeconds,
      durationSeconds: selection.durationSeconds,
    });
    this._renderTimelineSelection(selection);
    this.app.updatePreview();
  },

  _syncVideoSettings(img) {
    const panel = document.getElementById('videoSettings');
    if (!panel) return;
    let metadata = mediaMetadataFromNode(img);
    panel.hidden = !metadata;
    if (!metadata) return;
    const selection = this._clampTimelineSelection(metadata);
    const storedStart = normalizeVideoStart(img.dataset.mediaStart);
    const storedDuration = normalizeVideoDuration(img.dataset.mediaDuration);
    if (selection.startSeconds !== storedStart || selection.durationSeconds !== storedDuration) {
      applyMediaMetadataToImage(img, {
        ...metadata,
        startSeconds: selection.startSeconds,
        durationSeconds: selection.durationSeconds,
      });
      metadata = mediaMetadataFromNode(img);
      this.app.saveDraft();
    }
    document.getElementById('mediaOutputMode').value = metadata.mode;
    this._syncDurationSelect(metadata.durationSeconds, metadata.sourceDuration);
    const startInput = document.getElementById('mediaStart');
    startInput.value = String(metadata.startSeconds);
    startInput.max = String(selection.maxStart);
    document.getElementById('mediaSound').checked = metadata.keepSound;
    const status = document.getElementById('mediaLocalStatus');
    if (status) {
      const durationLabel = metadata.sourceDuration ? `源视频 ${metadata.sourceDuration.toFixed(1)} 秒` : '源视频时长未知';
      status.textContent = `${durationLabel} · 素材仅保存在当前设备，备份草稿时会一并带走`;
    }
    const liveHint = document.getElementById('mediaLiveHint');
    if (liveHint) liveHint.hidden = metadata.mode !== 'live-photo';
    this._renderTimelineSelection(selection, metadata.sourceDuration);
    void this._prepareVideoTimeline(img, metadata);
  },

  updateSelectedVideoSettings() {
    if (!this.selectedImg) return;
    const metadata = mediaMetadataFromNode(this.selectedImg);
    if (!metadata) return;
    const mode = normalizeVideoMode(document.getElementById('mediaOutputMode').value);
    const durationSeconds = normalizeVideoDuration(document.getElementById('mediaDuration').value);
    const requestedStart = normalizeVideoStart(document.getElementById('mediaStart').value);
    const maximumStart = metadata.sourceDuration
      ? Math.max(0, metadata.sourceDuration - durationSeconds)
      : requestedStart;
    const startSeconds = Math.min(requestedStart, maximumStart);
    const keepSound = document.getElementById('mediaSound').checked;
    applyMediaMetadataToImage(this.selectedImg, {
      ...metadata,
      mode,
      durationSeconds,
      startSeconds,
      keepSound,
    });
    document.getElementById('mediaStart').value = String(startSeconds);
    this._syncVideoSettings(this.selectedImg);
    this.app.updatePreview();
  },

  insertVideoFromFile() {
    document.getElementById('videoInput').click();
  },

  handleVideoFile(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    void this._insertVideoFile(file);
  },

  async _createVideoPoster(file) {
    const objectURL = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = objectURL;
    const waitFor = (eventName, timeoutMessage) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, 15_000);
      const onSuccess = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('视频无法解码，请改用 H.264 MP4 或兼容的 MOV')); };
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener(eventName, onSuccess);
        video.removeEventListener('error', onError);
      };
      video.addEventListener(eventName, onSuccess, { once: true });
      video.addEventListener('error', onError, { once: true });
    });

    try {
      const metadataReady = waitFor('loadedmetadata', '读取视频信息超时');
      video.load();
      await metadataReady;
      const sourceWidth = Number(video.videoWidth) || 0;
      const sourceHeight = Number(video.videoHeight) || 0;
      const sourceDuration = Number(video.duration) || 0;
      if (!(sourceWidth > 0 && sourceHeight > 0 && sourceDuration > 0)) {
        throw new Error('视频尺寸或时长无法读取');
      }
      const posterTime = Math.min(0.2, Math.max(0, sourceDuration - 0.05));
      if (posterTime > 0.01) {
        const frameReady = waitFor('seeked', '生成视频封面超时');
        video.currentTime = posterTime;
        await frameReady;
      } else if (video.readyState < 2) {
        await waitFor('loadeddata', '视频首帧加载超时');
      }
      const scale = Math.min(1, 1500 / sourceWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(sourceWidth * scale));
      canvas.height = Math.max(2, Math.round(sourceHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建视频封面');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('视频封面生成失败')), 'image/jpeg', 0.9);
      });
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('视频封面读取失败'));
        reader.readAsDataURL(blob);
      });
      return { blob, dataURL, sourceWidth, sourceHeight, sourceDuration, posterTime };
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectURL);
    }
  },

  async _insertVideoFile(file) {
    if (!isSupportedVideoFile(file)) {
      alert('目前只支持 MP4 或 MOV 视频');
      return;
    }
    const accountId = this.app.accountId;
    const draftId = this.app.getActiveDraftId();
    if (!accountId || !draftId) {
      alert('请先新建草稿再插入视频；素材会保存在当前设备，备份草稿时会一并导出。');
      return;
    }
    this.app._setDraftStatus('正在读取视频并保存到本机…');
    const mediaId = safeDraftId(`m${Date.now()}${Math.random().toString(36).slice(2, 8)}`, `m${Date.now()}`);
    let store = null;
    try {
      const poster = await this._createVideoPoster(file);
      if (poster.sourceDuration < 3) {
        throw new Error('源视频不足 3 秒，请选择时长不少于 3 秒的 MP4 或 MOV');
      }
      store = await getCardMediaStore();
      const scope = { accountId, draftId, mediaId };
      const metadata = {
        name: safeMediaLabel(file.name, '视频素材'),
        mimeType: safeMediaLabel(file.type, CARD_VIDEO_EXTENSIONS.test(file.name || '') && /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4', 80),
        sourceWidth: poster.sourceWidth,
        sourceHeight: poster.sourceHeight,
        sourceDuration: poster.sourceDuration,
        posterTime: poster.posterTime,
      };
      await store.put({ ...scope, role: CARD_MEDIA_SOURCE_ROLE, blob: file, metadata });
      try {
        await store.put({ ...scope, role: CARD_MEDIA_POSTER_ROLE, blob: poster.blob, metadata });
      } catch (error) {
        await store.delete({ ...scope, role: CARD_MEDIA_SOURCE_ROLE }).catch(() => {});
        throw error;
      }

      const img = document.createElement('img');
      img.src = poster.dataURL;
      img.style.width = '100%';
      if (this.defaultImageFrame) img.dataset.frame = this.defaultImageFrame;
      applyMediaMetadataToImage(img, {
        id: mediaId,
        kind: 'video',
        mode: 'video',
        durationSeconds: supportsFiveSecondSelection(poster.sourceDuration) ? 5 : 3,
        startSeconds: 0,
        keepSound: true,
        name: metadata.name,
        mimeType: metadata.mimeType,
        sourceDuration: poster.sourceDuration,
        sourceDraftId: draftId,
      });
      this.editor.focus();
      document.execCommand('insertHTML', false, '<br>' + img.outerHTML + '<br>');
      this.app.updatePreview();
      const inserted = this.editor.querySelector(`img[data-media-id="${mediaId}"]`);
      if (inserted) this._selectImage(inserted);
      this.app._setDraftStatus('视频已保存到当前设备；请在图片设置下方选择视频或 Live Photo');
    } catch (error) {
      if (store) {
        const scope = { accountId, draftId, mediaId };
        await Promise.allSettled([
          store.delete({ ...scope, role: CARD_MEDIA_SOURCE_ROLE }),
          store.delete({ ...scope, role: CARD_MEDIA_POSTER_ROLE }),
        ]);
      }
      this.app._setDraftStatus(`⚠ 视频插入失败：${error.message || '未知错误'}`);
      alert(`视频插入失败：${error.message || '未知错误'}`);
    }
  },
});
