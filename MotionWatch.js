/**
 * MotionWatch v21 - Детектор движения в видео
 * 
 * Скрипт для отслеживания изменений кадров в видео через сравнение пикселей.
 * Предназначен для запуска в консоли браузера.
 * 
 * Основные возможности:
 * - Автоматическое или ручное определение видео элемента
 * - Детекция движения через сравнение кадров (RGB каналы)
 * - Настройка зон контроля (до 12 зон)
 * - Автокалибровка порога чувствительности
 * - Визуальная и звуковая тревога
 * - Перетаскиваемая панель управления
 * 
 * Использование:
 * 1. Скопируйте весь код в консоль браузера
 * 2. Скрипт автоматически найдет видео на странице
 * 3. Используйте панель управления для настройки
 * 
 * Горячие клавиши:
 * - 0 или Правый Shift: включить/выключить детектор
 * - 1 или Левый Shift: сбросить тревогу
 * 
 * Остановка:
 * - Нажмите кнопку "✕" в панели управления
 * - Или выполните: window.__videoMotionWatch.destroy()
 * 
 * @author Nikolay D
 * @version 21
 */
(() => {
  // Предотвращаем множественные запуски - уничтожаем предыдущий экземпляр если есть
  if (window.__videoMotionWatch?.destroy) window.__videoMotionWatch.destroy();

  // =========================
  // CONFIG
  // =========================
  const TARGET_SELECTOR = 'auto'; // '#myVideo' / '.player video' / 'video' / 'auto'

  const SAMPLE_W = 160, SAMPLE_H = 90;
  const PIXEL_STRIDE = 2;

  const THR = { def: 0.80, min: 0.01, max: 30.0, step: 0.01 };
  const OPA = { def: 0.32, min: 0.05, max: 0.95, step: 0.01 };

  // громкость для аудио тревоги (0..1)
  const VOL = { def: 0.12, min: 0.01, max: 0.60, step: 0.01 };

  const REF_UPDATE_EVERY = 12;

  const TOGGLE_CODES = new Set(['Digit0', 'ShiftRight']); // enable/disable
  const CLEAR_CODES  = new Set(['Digit1', 'ShiftLeft']);  // clear alarm

  const CAL = {
    samples: 260,
    trimTop: 0.10,
    madK: 6,
    safety: 1.15,
    uiUpdateEvery: 24,
    maxStalls: 14,
    frameWaitMs: 900,
    fallbackSampleMs: 45,
    minUsefulSamples: 60,
  };

  const UI_MIN_INTERVAL = 120;
  const PICKER_AUTO_HIGHLIGHT_MS = 2500;
  const PANEL_PADDING = 12; // отступ панели от краев экрана

  const ZONES_MAX = 12;
  const ZONE_MIN_PX = 8;      // минимум при рисовании (px на экране)
  const ZONE_MIN_NORM = 0.02; // минимум зоны (в долях)

  const ACTIVE_HIGHLIGHT_ENABLED = true;

  const ACTIVE_BLUE = {
    border: 'rgba(80,160,255,.70)',
    glow1: 'rgba(80,160,255,.16)',
    glow2: 'rgba(80,160,255,.10)',
    fill: 'rgba(80,160,255,.03)',
  };

  const ZONE_STYLE = {
    border: 'rgba(120,200,255,.90)',
    fill:   'rgba(120,200,255,.06)',
    glow:   'rgba(120,200,255,.14)',
  };

  const DRAW_STYLE = {
    border: 'rgba(160,240,255,1)',
    fill:   'rgba(160,240,255,.09)',
    glow:   'rgba(160,240,255,.20)',
  };

  const NS = `__motionwatch_v21_ru::${location.hostname}::${TARGET_SELECTOR}`;
  const LS_KEYS = {
    thr:      `${NS}::thr`,
    opa:      `${NS}::opa`,
    vol:      `${NS}::vol`,
    alarmMod: `${NS}::alarmMode`, // visual | audio | both
    min:      `${NS}::min`,
    zones:    `${NS}::zones`,
    pos:      `${NS}::pos`,       // ✅ позиция панели
  };

  // =========================
  // HELPERS
  // =========================
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const quant = (v, step) => Math.round(v / step) * step;
  
  // Упрощенная функция задержки (вместо await new Promise(r => setTimeout(r, ms)))
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
  // Универсальная функция создания элемента со стилями
  const createEl = (tag, styles = {}, text = '') => {
    const el = document.createElement(tag);
    if (Object.keys(styles).length) Object.assign(el.style, styles);
    if (text) el.textContent = text;
    return el;
  };
  
  // Создание слайдера с общими настройками
  const createSlider = (min, max, step, value) => {
    const slider = createEl('input', { width: '100%', accentColor: 'rgba(255,255,255,.75)' });
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);
    return slider;
  };
  
  // Создание чипа (chip элемента)
  const createChip = (text, minWidth = '78px') => {
    return createEl('span', {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2px 8px',
      borderRadius: '999px',
      border: '1px solid rgba(255,255,255,.14)',
      background: 'rgba(0,0,0,.18)',
      minWidth,
      flex: '0 0 auto'
    }, text);
  };
  
  // Создание мета-строки (левая + правая часть)
  const createMetaRow = () => {
    const row = createEl('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' });
    const left = createEl('div', { opacity: '.9' });
    const right = createEl('div', { opacity: '.9', fontVariantNumeric: 'tabular-nums' });
    row.appendChild(left);
    row.appendChild(right);
    return { row, left, right };
  };
  
  // Получение размеров элемента (работает даже для скрытых элементов через offsetWidth/Height)
  const getElSize = (el) => ({
    width: el.offsetWidth || (el.getBoundingClientRect ? el.getBoundingClientRect().width : 0),
    height: el.offsetHeight || (el.getBoundingClientRect ? el.getBoundingClientRect().height : 0)
  });
  
  // Применение позиции к элементу
  const setElPos = (el, x, y) => {
    if (!el) return;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.right = 'auto';
  };

  const clampThr = (v) => clamp(quant(Number(v) || 0, THR.step), THR.min, THR.max);
  const clampOpa = (v) => clamp(quant(Number(v) || 0, OPA.step), OPA.min, OPA.max);
  const clampVol = (v) => clamp(quant(Number(v) || 0, VOL.step), VOL.min, VOL.max);

  const isTypingTarget = (t) =>
    t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

  const getLSNum = (k, fallback) => {
    const x = Number(localStorage.getItem(k));
    return Number.isFinite(x) ? x : fallback;
  };

  const getLSStr = (k, fallback) => {
    const s = localStorage.getItem(k);
    return (typeof s === 'string' && s.length) ? s : fallback;
  };

  const getLSBool = (k, fallback) => {
    const v = localStorage.getItem(k);
    if (v === '1') return true;
    if (v === '0') return false;
    return fallback;
  };

  const getLSJSON = (k, fallback) => {
    try {
      const s = localStorage.getItem(k);
      if (!s) return fallback;
      const o = JSON.parse(s);
      return o ?? fallback;
    } catch {
      return fallback;
    }
  };

  const setLSJSON = (k, obj) => {
    try { localStorage.setItem(k, JSON.stringify(obj)); } catch {}
  };

  const modeLabelFromThr = (t) => {
    if (t <= 0.20) return 'Ультра';
    if (t <= 0.80) return 'Микро';
    if (t <= 2.00) return 'Норма';
    if (t <= 6.00) return 'Шумно';
    return 'Сильный шум';
  };

  const median = (arr) => {
    const a = arr.slice().sort((x, y) => x - y);
    const n = a.length;
    if (!n) return 0;
    const m = Math.floor(n / 2);
    return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  const percentile = (sortedAsc, p) => {
    if (!sortedAsc.length) return 0;
    const idx = (sortedAsc.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedAsc[lo];
    const w = idx - lo;
    return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
  };

  const setBtnDisabled = (btn, disabled) => {
    btn.disabled = !!disabled;
    btn.style.opacity = disabled ? '0.55' : '1';
    btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
  };

  const isFiniteNum = (x) => Number.isFinite(x) && !Number.isNaN(x);

  const alarmModeNormalize = (m) => (m === 'visual' || m === 'audio' || m === 'both') ? m : 'both';
  const alarmHasVisual = (m) => m === 'visual' || m === 'both';
  const alarmHasAudio  = (m) => m === 'audio'  || m === 'both';

  // =========================
  // AUDIO (beep on alarm)
  // =========================
  const Audio = {
    ctx: null,
    unlocked: false,
    timer: null,
    volume: VOL.def,

    async unlock() {
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        this.unlocked = true;
        return true;
      } catch {
        return false;
      }
    },

    beep({ freq = 880, ms = 140, volume = this.volume } = {}) {
      if (!this.unlocked || !this.ctx) return;

      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0);

      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(t0);
      osc.stop(t0 + ms / 1000 + 0.02);
    },

    startAlarmBeep() {
      if (!this.unlocked || !this.ctx) return;
      if (this.timer) return;

      this.beep({ freq: 880, ms: 130 });
      setTimeout(() => this.beep({ freq: 660, ms: 130 }), 160);

      this.timer = setInterval(() => {
        this.beep({ freq: 880, ms: 130 });
        setTimeout(() => this.beep({ freq: 660, ms: 130 }), 160);
      }, 1100);
    },

    stopAlarmBeep() {
      if (!this.timer) return;
      clearInterval(this.timer);
      this.timer = null;
    },

    destroy() {
      this.stopAlarmBeep();
      try { this.ctx?.close?.(); } catch {}
      this.ctx = null;
      this.unlocked = false;
    }
  };

  // =========================
  // UI
  // =========================
  function createUI() {
    const mkBtn = (txt, tip) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.title = tip || '';
      Object.assign(b.style, {
        height: '28px',
        padding: '0 10px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,.14)',
        background: 'rgba(255,255,255,.08)',
        color: '#fff',
        cursor: 'pointer',
        lineHeight: '28px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      });
      b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,.14)');
      b.addEventListener('mouseleave', () => b.style.background = 'rgba(255,255,255,.08)');
      return b;
    };

    const card = (titleText) => {
      const c = document.createElement('div');
      Object.assign(c.style, {
        border: '1px solid rgba(255,255,255,.10)',
        background: 'rgba(255,255,255,.06)',
        borderRadius: '14px',
        padding: '10px',
        marginBottom: '10px'
      });
      const h = document.createElement('div');
      h.textContent = titleText;
      Object.assign(h.style, { fontWeight: '650', marginBottom: '8px' });
      c.appendChild(h);
      return c;
    };

    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      background: 'rgba(255,60,60,1)',
      opacity: String(OPA.def),
      zIndex: '999999',
      pointerEvents: 'none',
      transition: 'opacity 120ms ease',
    });
    document.body.appendChild(overlay);

    const activeBox = document.createElement('div');
    Object.assign(activeBox.style, {
      position: 'fixed',
      display: 'none',
      zIndex: '999998',
      pointerEvents: 'none',
      border: `1px solid ${ACTIVE_BLUE.border}`,
      borderRadius: '10px',
      boxShadow: `0 0 0 5px ${ACTIVE_BLUE.glow1}, 0 0 18px ${ACTIVE_BLUE.glow2}`,
      background: ACTIVE_BLUE.fill,
      transform: 'translate(-99999px, -99999px)',
      opacity: '0.90',
      transition: 'opacity 140ms ease',
    });
    document.body.appendChild(activeBox);

    const zonesLayer = document.createElement('div');
    Object.assign(zonesLayer.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '1000001',
      pointerEvents: 'none',
    });
    document.body.appendChild(zonesLayer);

    const drawBox = document.createElement('div');
    Object.assign(drawBox.style, {
      position: 'fixed',
      display: 'none',
      zIndex: '1000002',
      pointerEvents: 'none',
      border: `2px solid ${DRAW_STYLE.border}`,
      borderRadius: '10px',
      boxShadow: `0 0 0 6px ${DRAW_STYLE.glow}`,
      background: DRAW_STYLE.fill,
      transform: 'translate(-99999px, -99999px)',
    });
    document.body.appendChild(drawBox);

    const pickBox = document.createElement('div');
    Object.assign(pickBox.style, {
      position: 'fixed',
      display: 'none',
      zIndex: '1000003',
      pointerEvents: 'none',
      border: '2px solid rgba(80,160,255,.95)',
      borderRadius: '10px',
      boxShadow: '0 0 0 6px rgba(80,160,255,.12)',
      background: 'rgba(80,160,255,.06)',
      transform: 'translate(-99999px, -99999px)',
    });
    document.body.appendChild(pickBox);

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: '1000000',
      width: 'min(460px, calc(100vw - 24px))',
      maxHeight: 'calc(100vh - 24px)',
      overflowY: 'auto',
      overscrollBehavior: 'contain',
      boxSizing: 'border-box',
      borderRadius: '16px',
      padding: '10px',
      color: '#fff',
      font: '11.5px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      background: 'rgba(18,18,18,.55)',
      backdropFilter: 'blur(10px)',
      boxShadow: '0 14px 40px rgba(0,0,0,.22)',
      border: '1px solid rgba(255,255,255,.10)',
      userSelect: 'none',
      scrollbarWidth: 'thin',
      scrollbarColor: 'rgba(255,255,255,.28) rgba(0,0,0,0)',
    });
    document.body.appendChild(panel);

    const mini = document.createElement('div');
    Object.assign(mini.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: '1000000',
      display: 'none',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 10px',
      borderRadius: '999px',
      color: '#fff',
      font: '12px/1.25 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      background: 'rgba(18,18,18,.55)',
      backdropFilter: 'blur(10px)',
      boxShadow: '0 14px 40px rgba(0,0,0,.22)',
      border: '1px solid rgba(255,255,255,.10)',
      userSelect: 'none',
      cursor: 'pointer'
    });
    document.body.appendChild(mini);

    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '10px',
      height: '10px',
      borderRadius: '999px',
      display: 'inline-block',
      boxShadow: '0 0 0 3px rgba(255,255,255,.10)',
      flex: '0 0 auto'
    });

    const miniDot = dot.cloneNode(true);
    const miniText = document.createElement('div');
    Object.assign(miniText.style, { opacity: '.9', fontWeight: '650' });
    miniText.textContent = 'Движение';
    mini.appendChild(miniDot);
    mini.appendChild(miniText);

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '10px',

      // ✅ sticky header внутри скролла панели - прилипает к самому верху панели
      position: 'sticky',
      top: '-10px', // компенсируем padding панели, чтобы header примыкал к верху
      zIndex: '5',

      // ✅ чтобы выглядело аккуратно при липком режиме
      background: 'rgba(18,18,18,.72)',
      backdropFilter: 'blur(10px)',
      borderBottom: '1px solid rgba(255,255,255,.08)',

      // ✅ растянуть на ширину панели (компенсировать padding) и закруглить верхние углы
      margin: '-10px -10px 10px -10px',
      padding: '10px',
      borderRadius: '16px 16px 0 0', // только верхние углы, чтобы соответствовать панели
    });

    const headLeft = document.createElement('div');
    Object.assign(headLeft.style, { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 });

    const titleBox = document.createElement('div');
    Object.assign(titleBox.style, { minWidth: 0 });

    const title = document.createElement('div');
    title.textContent = 'Детектор движения';
    Object.assign(title.style, { fontWeight: '700', fontSize: '13px', letterSpacing: '.2px' });

    const subtitle = document.createElement('div');
    Object.assign(subtitle.style, { opacity: '.82', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

    titleBox.appendChild(title);
    titleBox.appendChild(subtitle);
    headLeft.appendChild(dot);
    headLeft.appendChild(titleBox);

    const headBtns = document.createElement('div');
    Object.assign(headBtns.style, { display: 'flex', gap: '8px', alignItems: 'center', flex: '0 0 auto' });

    const mkSquare = (txt, tip) => {
      const b = mkBtn(txt, tip);
      b.style.width = '36px';
      b.style.padding = '0';
      return b;
    };

    const btnMin = mkSquare('–', 'Свернуть панель (детектор продолжает работать)');
    const btnClose = mkSquare('✕', 'Остановить и удалить');

    headBtns.appendChild(btnMin);
    headBtns.appendChild(btnClose);

    header.appendChild(headLeft);
    header.appendChild(headBtns);

    // Hotkeys
    const hk = card('Горячие клавиши');
    const hkGrid = document.createElement('div');
    Object.assign(hkGrid.style, { display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 10px', alignItems: 'center' });

    const pill = (t) => createEl('span', {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2px 8px',
      borderRadius: '999px',
      border: '1px solid rgba(255,255,255,.14)',
      background: 'rgba(0,0,0,.18)',
      fontWeight: '600'
    }, t);

    const hkRow = (label, keys) => {
      const l = createEl('div', { opacity: '.9' }, label);
      const k = createEl('div', { display: 'inline-flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' });
      keys.forEach(x => k.appendChild(pill(x)));
      hkGrid.appendChild(l);
      hkGrid.appendChild(k);
    };

    hkRow('Вкл/выкл детектор', ['0', 'Правый Shift']);
    hkRow('Сброс тревоги', ['1', 'Левый Shift']);
    hk.appendChild(hkGrid);

    // Reaction
    const react = card('Реакция на тревогу');

    const seg = document.createElement('div');
    Object.assign(seg.style, {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: '8px'
    });

    const mkSegBtn = (txt, tip) => {
      const b = mkBtn(txt, tip);
      b.style.width = '100%';
      b.style.justifyContent = 'center';
      b.style.textAlign = 'center';
      b.style.padding = '0 8px';
      return b;
    };

    const btnModeVisual = mkSegBtn('Только визуал', 'Красный фон, без звука');
    const btnModeAudio  = mkSegBtn('Только звук',   'Звук, без красного фона');
    const btnModeBoth   = mkSegBtn('Вместе',        'Красный фон + звук');

    seg.appendChild(btnModeVisual);
    seg.appendChild(btnModeAudio);
    seg.appendChild(btnModeBoth);

    const audioLine = createEl('div', { marginTop: '10px' });

    const { row: audioTop, left: audioLeft, right: audioRight } = createMetaRow();
    audioLeft.textContent = 'Громкость сигнала';

    const audioRow = createEl('div', { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' });

    const sliderVol = createSlider(VOL.min, VOL.max, VOL.step, VOL.def);
    const volChip = createChip('');

    audioRow.appendChild(sliderVol);
    audioRow.appendChild(volChip);

    const audioHint = createEl('div', { marginTop: '8px', opacity: '.78' }, 'Если звук не слышен — нажми любую клавишу или кликни по странице (браузер разблокирует звук).');

    audioLine.appendChild(audioTop);
    audioLine.appendChild(audioRow);
    audioLine.appendChild(audioHint);

    react.appendChild(seg);
    react.appendChild(audioLine);

    // Sensitivity
    const sens = card('Чувствительность');

    const { row: meta, left: metaLeft, right: metaRight } = createMetaRow();

    const thrRow = createEl('div', { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' });

    const sliderThr = createSlider(THR.min, THR.max, THR.step, THR.def);
    const modeChip = createChip('', '110px');

    thrRow.appendChild(sliderThr);
    thrRow.appendChild(modeChip);

    const btnRow = createEl('div', { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' });

    const btnAuto = mkBtn('Автокалибровка', `Собирает статистику и выставляет порог (по зонам)`);
    btnAuto.style.flex = '1 1 160px';

    const btnReset = mkBtn('Сброс', 'Сбросить порог по умолчанию');

    btnRow.appendChild(btnAuto);
    btnRow.appendChild(btnReset);

    const hintThr = createEl('div', { marginTop: '8px', opacity: '.78' }, 'Меньше порог — реагирует на малейшие изменения. Больше порог — сильнее подавляет шум.');

    sens.appendChild(meta);
    sens.appendChild(thrRow);
    sens.appendChild(btnRow);
    sens.appendChild(hintThr);

    // Opacity
    const opa = card('Прозрачность красного фона');

    const { row: opaMeta, left: opaLeft, right: opaRight } = createMetaRow();
    opaLeft.textContent = 'Насколько ярко перекрывать экран';

    const opaRow = createEl('div', { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' });
    const sliderOpa = createSlider(OPA.min, OPA.max, OPA.step, OPA.def);
    const opaChip = createChip('');

    opaRow.appendChild(sliderOpa);
    opaRow.appendChild(opaChip);

    const hintOpa = createEl('div', { marginTop: '8px', opacity: '.78' }, 'Если мешает смотреть — уменьши.');

    opa.appendChild(opaMeta);
    opa.appendChild(opaRow);
    opa.appendChild(hintOpa);

    // Zones (без редактирования)
    const zones = card('Зоны контроля');

    const zonesRow1 = createEl('div', { display: 'flex', gap: '8px', flexWrap: 'wrap' });

    const btnZoneAdd = mkBtn('Добавить зону', 'Нарисуй прямоугольник внутри видео (Esc — отмена)');
    btnZoneAdd.style.flex = '1 1 160px';

    const btnZoneUndo = mkBtn('Отменить последнюю', 'Удалить последнюю добавленную зону');
    const btnZoneClear = mkBtn('Очистить зоны', 'Сбросить зоны (будет отслеживаться всё видео)');

    zonesRow1.appendChild(btnZoneAdd);
    zonesRow1.appendChild(btnZoneUndo);
    zonesRow1.appendChild(btnZoneClear);

    const zonesHint = createEl('div', { marginTop: '8px', opacity: '.78' }, `До ${ZONES_MAX} зон. Если зон нет — отслеживается всё видео.`);

    zones.appendChild(zonesRow1);
    zones.appendChild(zonesHint);

    // Footer
    const footer = document.createElement('div');
    Object.assign(footer.style, { display: 'flex', alignItems: 'flex-start', gap: '10px' });

    const footerLeft = document.createElement('div');
    Object.assign(footerLeft.style, {
      opacity: '.85',
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      paddingTop: '4px'
    });

    const footerRight = document.createElement('div');
    Object.assign(footerRight.style, {
      flex: '0 0 auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      alignItems: 'stretch'
    });

    const btnPickAuto = mkBtn('Перевыбрать видео', 'Заново выбрать <video> (только auto) и перезапустить');
    btnPickAuto.style.maxWidth = '190px';

    const btnPipette = mkBtn('🎯 Выбрать видео кликом', 'Выбрать нужное видео кликом по странице (Esc — отмена)');
    btnPipette.style.maxWidth = '190px';

    const btnBackAuto = mkBtn('↩ Авто-выбор', 'Вернуться к режиму TARGET_SELECTOR');
    btnBackAuto.style.maxWidth = '190px';
    btnBackAuto.style.display = 'none';

    footerRight.appendChild(btnPickAuto);
    footerRight.appendChild(btnPipette);
    footerRight.appendChild(btnBackAuto);

    footer.appendChild(footerLeft);
    footer.appendChild(footerRight);

    panel.appendChild(header);
    panel.appendChild(hk);
    panel.appendChild(react);
    panel.appendChild(sens);
    panel.appendChild(opa);
    panel.appendChild(zones);
    panel.appendChild(footer);

    return {
      header, // ✅ нужно для drag + dblclick reset
      overlay, activeBox, zonesLayer, drawBox, pickBox,
      panel, mini, dot, miniDot, miniText,
      subtitle,
      btnModeVisual, btnModeAudio, btnModeBoth,
      audioRight, sliderVol, volChip, audioLine,
      metaLeft, metaRight, modeChip,
      opaRight, opaChip,
      footerLeft,
      sliderThr, sliderOpa,
      btnAuto, btnReset, btnMin, btnClose,
      btnPickAuto, btnPipette, btnBackAuto,
      btnZoneAdd, btnZoneUndo, btnZoneClear,
    };
  }

  // =========================
  // STATE
  // =========================
  const UI = createUI();

  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const sanitizeZone = (r) => {
    const x = clamp(Number(r?.x ?? 0), 0, 1);
    const y = clamp(Number(r?.y ?? 0), 0, 1);
    const w = clamp(Number(r?.w ?? 1), 0, 1);
    const h = clamp(Number(r?.h ?? 1), 0, 1);

    const w2 = clamp(w, ZONE_MIN_NORM, 1);
    const h2 = clamp(h, ZONE_MIN_NORM, 1);
    const x2 = clamp(x, 0, 1 - w2);
    const y2 = clamp(y, 0, 1 - h2);
    return { x: x2, y: y2, w: w2, h: h2 };
  };

  const sanitizeZones = (zones) => {
    if (!Array.isArray(zones)) return [];
    const out = [];
    for (const z of zones) {
      const s = sanitizeZone(z);
      if (s.w >= ZONE_MIN_NORM && s.h >= ZONE_MIN_NORM) out.push(s);
      if (out.length >= ZONES_MAX) break;
    }
    return out;
  };

  const S = {
    enabled: true,
    blocked: false,
    calibrating: false,
    alarm: false,
    picking: false,
    drawingZone: false,

    thr: clampThr(getLSNum(LS_KEYS.thr, THR.def)),
    opacity: clampOpa(getLSNum(LS_KEYS.opa, OPA.def)),
    alarmMode: alarmModeNormalize(getLSStr(LS_KEYS.alarmMod, 'both')),
    volume: clampVol(getLSNum(LS_KEYS.vol, VOL.def)),
    minimized: getLSBool(LS_KEYS.min, false),

    manualVideo: null,
    video: null,

    zones: sanitizeZones(getLSJSON(LS_KEYS.zones, [])),
    zoneEls: [],

    drawDrag: null,

    prev: null,
    ref: null,
    refCounter: 0,

    d: 0, dPrev: 0, dRef: 0,
    status: 'инициализация…',

    stop: false,
    mo: null,
    lastUI: 0,

    pickTarget: null,
    pickHoverSeen: false,
    pickAutoTimer: 0,
    pickMoveH: null,
    pickClickH: null,
    pickKeyH: null,

    zDownH: null,
    zMoveH: null,
    zUpH: null,
    zKeyH: null,

    onViewportChange: null,

    audioUnlockKeyH: null,
    audioUnlockPtrH: null,
    keyH: null,

    // ✅ drag state
    pos: null,
    dragMoved: false,
    dragCleanupPanel: null,
    dragCleanupMini: null,
    headerDblH: null,
  };

  UI.sliderThr.value = String(S.thr);
  UI.sliderOpa.value = String(S.opacity);
  UI.overlay.style.opacity = String(S.opacity);

  UI.sliderVol.value = String(S.volume);
  Audio.volume = S.volume;

  // =========================
  // DRAG PANEL / MINI + SAVE POS
  // =========================
  
  // Вычисление позиции мини-панели относительно правого края панели с проверкой границ
  const calcMiniPosFromPanel = (panelX, panelY, panelWidth, checkBounds = false) => {
    const miniSize = getElSize(UI.mini);
    let miniX = panelX + panelWidth - miniSize.width;
    let miniY = panelY;
    
    // Проверяем границы экрана, если требуется
    if (checkBounds) {
      const maxX = window.innerWidth - miniSize.width - PANEL_PADDING;
      const maxY = window.innerHeight - miniSize.height - PANEL_PADDING;
      miniX = clamp(Math.round(miniX), PANEL_PADDING, maxX);
      miniY = clamp(Math.round(miniY), PANEL_PADDING, maxY);
    }
    
    return { x: miniX, y: miniY };
  };
  
  // Вычисление позиции панели относительно правого края мини-панели
  const calcPanelPosFromMini = (miniRight, miniTop) => {
    const panelSize = getElSize(UI.panel);
    return {
      x: miniRight - panelSize.width,
      y: miniTop
    };
  };
  
  // Синхронизация позиции мини-панели с правым краем панели
  const syncMiniToPanel = (panelX, panelY, checkBounds = false) => {
    const panelSize = getElSize(UI.panel);
    const miniPos = calcMiniPosFromPanel(panelX, panelY, panelSize.width, checkBounds);
    setElPos(UI.mini, miniPos.x, miniPos.y);
  };
  
  function getSavedPos() {
    const p = getLSJSON(LS_KEYS.pos, null);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    return null;
  }

  function applyPos(x, y, save = false) {
    const baseEl = S.minimized ? UI.mini : UI.panel;
    const baseSize = getElSize(baseEl);

    const maxX = Math.max(PANEL_PADDING, window.innerWidth - baseSize.width - PANEL_PADDING);
    const maxY = Math.max(PANEL_PADDING, window.innerHeight - baseSize.height - PANEL_PADDING);

    const nx = clamp(Math.round(x), PANEL_PADDING, maxX);
    const ny = clamp(Math.round(y), PANEL_PADDING, maxY);

    // Применяем позицию к панели
    setElPos(UI.panel, nx, ny);
    
    // Синхронизируем позицию мини-панели: её правый край = правый край панели
    // Проверяем границы, чтобы мини-панель не ушла за пределы экрана
    syncMiniToPanel(nx, ny, true);

    S.pos = { x: nx, y: ny };
    if (save) setLSJSON(LS_KEYS.pos, S.pos);
  }

  function setPosTopRight(save = true) {
    // Используем panel для расчета, так как mini может быть скрыт
    const panelSize = getElSize(UI.panel);
    const x = window.innerWidth - panelSize.width - PANEL_PADDING;
    const y = PANEL_PADDING;
    applyPos(x, y, save);
  }

  function initPosOnce() {
    const saved = getSavedPos();
    if (saved) {
      applyPos(saved.x, saved.y, false);
      return;
    }
    requestAnimationFrame(() => setPosTopRight(true));
  }

  function attachDrag(handleEl) {
    let dragging = false;
    let sx = 0, sy = 0;
    let ox = 0, oy = 0;
    let isMini = false;

    const isBadTarget = (t) =>
      t?.closest?.('button, input, select, textarea, a, label');

    const onDown = (e) => {
      if (e.button !== 0) return;
      if (isBadTarget(e.target)) return;

      dragging = true;
      S.dragMoved = false;

      sx = e.clientX; sy = e.clientY;
      
      // Определяем, какой элемент перетаскивается (mini или panel)
      isMini = handleEl === UI.mini || UI.mini.contains(handleEl);
      const currentEl = isMini ? UI.mini : UI.panel;
      const rect = currentEl.getBoundingClientRect();
      
      // Используем текущую позицию перетаскиваемого элемента
      ox = rect.left;
      oy = rect.top;

      try { handleEl.setPointerCapture?.(e.pointerId); } catch {}
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;

      if (Math.abs(dx) + Math.abs(dy) > 3) S.dragMoved = true;
      
      const newX = ox + dx;
      const newY = oy + dy;
      
      if (isMini) {
        // Перетаскиваем мини-панель независимо
        const miniSize = getElSize(UI.mini);
        const maxX = Math.max(PANEL_PADDING, window.innerWidth - miniSize.width - PANEL_PADDING);
        const maxY = Math.max(PANEL_PADDING, window.innerHeight - miniSize.height - PANEL_PADDING);
        
        const nx = clamp(Math.round(newX), PANEL_PADDING, maxX);
        const ny = clamp(Math.round(newY), PANEL_PADDING, maxY);
        
        setElPos(UI.mini, nx, ny);
        
        // Обновляем позицию большой панели: её правый край = правый край мини-панели
        const panelSize = getElSize(UI.panel);
        const panelX = nx + miniSize.width - panelSize.width;
        S.pos = { x: panelX, y: ny };
      } else {
        // Перетаскиваем большую панель
        applyPos(newX, newY, false);
      }
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      
      if (isMini) {
        // Сохраняем позицию мини-панели и вычисляем позицию большой панели
        const miniX = parseInt(UI.mini.style.left) || UI.mini.getBoundingClientRect().left;
        const miniY = parseInt(UI.mini.style.top) || UI.mini.getBoundingClientRect().top;
        const miniRight = miniX + getElSize(UI.mini).width;
        
        // Позиция большой панели: её правый край = правый край мини-панели
        const panelPos = calcPanelPosFromMini(miniRight, miniY);
        S.pos = { x: panelPos.x, y: panelPos.y };
        setLSJSON(LS_KEYS.pos, S.pos);
      } else {
        // Сохраняем позицию большой панели (applyPos уже синхронизирует mini)
        if (S.pos) {
          applyPos(S.pos.x, S.pos.y, true);
        }
      }
      
      setTimeout(() => { S.dragMoved = false; }, 0);
    };

    handleEl.addEventListener('pointerdown', onDown, { passive: false });
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });

    return () => {
      handleEl.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }

  // =========================
  // VIDEO SELECTION
  // =========================
  // Проверка валидности видео элемента
  function isValidVideo(video) {
    return video && document.contains(video) && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  }

  function pickVideoAuto() {
    const vids = Array.from(document.querySelectorAll('video'));
    const playing = vids.find(v => !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0);
    if (playing) return playing;

    return vids
      .filter(v => v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0)
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || null;
  }

  function resolveVideo() {
    if (S.manualVideo && document.contains(S.manualVideo)) return S.manualVideo;
    if (TARGET_SELECTOR === 'auto') return pickVideoAuto();
    return document.querySelector(TARGET_SELECTOR);
  }

  // =========================
  // FRAMES
  // =========================
  function nextFrame(timeoutMs = 800) {
    return new Promise((resolve) => {
      const v = S.video;
      if (!v) return resolve(false);

      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };

      const t = setTimeout(() => finish(false), timeoutMs);

      try {
        if (typeof v.requestVideoFrameCallback === 'function') {
          v.requestVideoFrameCallback(() => {
            clearTimeout(t);
            finish(true);
          });
        } else {
          requestAnimationFrame(() => {
            clearTimeout(t);
            finish(true);
          });
        }
      } catch {
        clearTimeout(t);
        finish(false);
      }
    });
  }

  function captureFrame() {
    ctx.drawImage(S.video, 0, 0, SAMPLE_W, SAMPLE_H);
    return ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
  }

  function zonesToSampleBounds(zones) {
    if (!zones.length) return [{ x0: 0, y0: 0, x1: SAMPLE_W, y1: SAMPLE_H }];

    return zones.map(z => {
      const r = sanitizeZone(z);
      const x0 = clamp(Math.floor(r.x * SAMPLE_W), 0, SAMPLE_W - 1);
      const y0 = clamp(Math.floor(r.y * SAMPLE_H), 0, SAMPLE_H - 1);
      const x1 = clamp(Math.ceil((r.x + r.w) * SAMPLE_W), x0 + 1, SAMPLE_W);
      const y1 = clamp(Math.ceil((r.y + r.h) * SAMPLE_H), y0 + 1, SAMPLE_H);
      return { x0, y0, x1, y1 };
    });
  }

  function avgDiffPerChannelROI(curr, prev, bounds) {
    const { x0, y0, x1, y1 } = bounds;
    let sum = 0;
    let count = 0;
    const s = Math.max(1, PIXEL_STRIDE);

    for (let y = y0; y < y1; y += s) {
      let idx = (y * SAMPLE_W + x0) * 4;
      for (let x = x0; x < x1; x += s) {
        sum += Math.abs(curr[idx]     - prev[idx]);
        sum += Math.abs(curr[idx + 1] - prev[idx + 1]);
        sum += Math.abs(curr[idx + 2] - prev[idx + 2]);
        count++;
        idx += s * 4;
      }
    }
    return count ? (sum / (count * 3)) : 0;
  }

  function motionAcrossZones(currArr, prevArr, boundsList) {
    let maxD = 0;
    for (const b of boundsList) {
      const d = avgDiffPerChannelROI(currArr, prevArr, b);
      if (d > maxD) maxD = d;
    }
    return maxD;
  }

  function computeAutoThreshold(diffs) {
    const sorted = diffs.slice().sort((a, b) => a - b);
    const cut = Math.floor(sorted.length * (1 - CAL.trimTop));
    const trimmed = sorted.slice(0, Math.max(10, cut));

    const m = median(trimmed);
    const absDev = trimmed.map(x => Math.abs(x - m));
    const mad = median(absDev);
    const robustStd = 1.4826 * mad;

    const robustThr = m + CAL.madK * robustStd;
    const p95 = percentile(trimmed, 0.95);

    return clampThr(Math.max(p95, robustThr) * CAL.safety);
  }

  // =========================
  // VISUALS (boxes)
  // =========================
  function placeBoxAbs(el, left, top, w, h) {
    el.style.display = 'block';
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${Math.round(h)}px`;
  }

  function hideBox(el) {
    el.style.display = 'none';
    el.style.transform = 'translate(-99999px, -99999px)';
  }

  function updateActiveHighlight() {
    if (!ACTIVE_HIGHLIGHT_ENABLED) return;

    const shouldShow =
      !S.minimized &&
      !S.blocked &&
      S.enabled &&
      !S.alarm &&
      !S.picking &&
      !S.drawingZone &&
      isValidVideo(S.video);

    if (!shouldShow) return hideBox(UI.activeBox);

    const r = S.video.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return hideBox(UI.activeBox);
    placeBoxAbs(UI.activeBox, r.left, r.top, r.width, r.height);
  }

  function reconcileZoneEls(count) {
    while (S.zoneEls.length < count) {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'fixed',
        display: 'none',
        pointerEvents: 'none',
        border: `2px solid ${ZONE_STYLE.border}`,
        borderRadius: '10px',
        boxShadow: `0 0 0 6px ${ZONE_STYLE.glow}`,
        background: ZONE_STYLE.fill,
        zIndex: '1000001',
        transform: 'translate(-99999px, -99999px)',
        touchAction: 'none',
      });

      const badge = document.createElement('div');
      badge.className = 'mw-zone-badge';
      Object.assign(badge.style, {
        position: 'absolute',
        top: '6px',
        left: '6px',
        padding: '2px 6px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: '650',
        background: 'rgba(0,0,0,.35)',
        border: '1px solid rgba(255,255,255,.14)',
        color: 'rgba(255,255,255,.92)',
        pointerEvents: 'none',
        userSelect: 'none'
      });
      el.appendChild(badge);

      UI.zonesLayer.appendChild(el);
      S.zoneEls.push(el);
    }

    while (S.zoneEls.length > count) {
      const el = S.zoneEls.pop();
      el.remove();
    }
  }

  function updateZonesBoxes() {
    if (S.minimized || !isValidVideo(S.video)) {
      reconcileZoneEls(0);
      return;
    }

    const vr = S.video.getBoundingClientRect();
    if (vr.width <= 1 || vr.height <= 1) {
      reconcileZoneEls(0);
      return;
    }

    const zones = S.zones;
    reconcileZoneEls(zones.length);

    zones.forEach((z, i) => {
      const r = sanitizeZone(z);
      const left = vr.left + r.x * vr.width;
      const top  = vr.top  + r.y * vr.height;
      const w    = r.w * vr.width;
      const h    = r.h * vr.height;

      const el = S.zoneEls[i];
      const badge = el.querySelector('.mw-zone-badge');
      if (badge) badge.textContent = `Зона ${i + 1}`;
      placeBoxAbs(el, left, top, w, h);
    });
  }

  function updateDrawBox() {
    if (!S.drawingZone || !S.drawDrag) return hideBox(UI.drawBox);
    const vr = S.drawDrag.vr;

    const xA = clamp(S.drawDrag.startX, vr.left, vr.right);
    const yA = clamp(S.drawDrag.startY, vr.top, vr.bottom);
    const xB = clamp(S.drawDrag.curX,   vr.left, vr.right);
    const yB = clamp(S.drawDrag.curY,   vr.top, vr.bottom);

    const left = Math.min(xA, xB);
    const top  = Math.min(yA, yB);
    const w    = Math.max(2, Math.abs(xB - xA));
    const h    = Math.max(2, Math.abs(yB - yA));

    placeBoxAbs(UI.drawBox, left, top, w, h);
  }

  // =========================
  // ALARM (visual/audio mode)
  // =========================
  function showAlarm() {
    if (S.alarm) return;
    S.alarm = true;

    if (alarmHasVisual(S.alarmMode)) UI.overlay.style.display = 'block';
    else UI.overlay.style.display = 'none';

    if (alarmHasAudio(S.alarmMode)) Audio.startAlarmBeep();
    else Audio.stopAlarmBeep();

    updateActiveHighlight();
  }

  function clearAlarm() {
    S.alarm = false;
    UI.overlay.style.display = 'none';
    Audio.stopAlarmBeep();
    updateActiveHighlight();
  }

  function applyAlarmMode(mode, statusMsg) {
    S.alarmMode = alarmModeNormalize(mode);
    localStorage.setItem(LS_KEYS.alarmMod, S.alarmMode);

    if (S.alarm) {
      if (alarmHasVisual(S.alarmMode)) UI.overlay.style.display = 'block';
      else UI.overlay.style.display = 'none';

      if (alarmHasAudio(S.alarmMode)) Audio.startAlarmBeep();
      else Audio.stopAlarmBeep();
    }

    if (statusMsg) S.status = statusMsg;
    refreshUI(true);
  }

  function applyVolume(v, statusMsg) {
    S.volume = clampVol(v);
    UI.sliderVol.value = String(S.volume);
    Audio.volume = S.volume;
    localStorage.setItem(LS_KEYS.vol, String(S.volume));

    if (S.alarm && alarmHasAudio(S.alarmMode)) {
      Audio.stopAlarmBeep();
      Audio.startAlarmBeep();
    }

    if (statusMsg) S.status = statusMsg;
    refreshUI(true);
  }

  // =========================
  // UI / STATUS
  // =========================
  function setDot(state) {
    const c =
      state === 'blocked' ? 'rgba(255,60,60,1)' :
      state === 'on' ? 'rgba(80,160,255,1)' :
      'rgba(160,160,160,1)';

    UI.dot.style.background = c;
    UI.miniDot.style.background = c;

    const border =
      state === 'on' ? 'rgba(80,160,255,.20)' :
      state === 'blocked' ? 'rgba(255,60,60,.22)' :
      'rgba(160,160,160,.18)';

    UI.panel.style.borderColor = border;
    UI.mini.style.borderColor = border;
  }

  function applyMinimized(val) {
    S.minimized = !!val;
    localStorage.setItem(LS_KEYS.min, S.minimized ? '1' : '0');
    
    // ✅ перед сворачиванием сохраняем текущую позицию panel
    if (val) {
      const panelRect = UI.panel.getBoundingClientRect();
      
      // Получаем размеры мини-панели (временно показываем для точного измерения)
      const wasVisible = UI.mini.style.display !== 'none';
      UI.mini.style.display = 'inline-flex';
      const miniSize = getElSize(UI.mini);
      if (!wasVisible) UI.mini.style.display = 'none';
      
      // Вычисляем идеальную позицию мини-панели: правый край мини = правый край панели
      const idealMiniX = panelRect.right - miniSize.width;
      const maxMiniX = window.innerWidth - miniSize.width - PANEL_PADDING;
      const minMiniX = PANEL_PADDING;
      
      // Вычисляем финальную позицию мини-панели с учетом границ
      let finalMiniX = clamp(idealMiniX, minMiniX, maxMiniX);
      let finalMiniY = clamp(panelRect.top, PANEL_PADDING, window.innerHeight - miniSize.height - PANEL_PADDING);
      
      // Если мини-панель была скорректирована из-за границ, корректируем позицию панели
      // чтобы при разворачивании мини-панель была на месте кнопок
      let adjustedPanelX = panelRect.left;
      if (finalMiniX !== idealMiniX) {
        // Мини-панель была сдвинута - корректируем позицию панели
        const diff = idealMiniX - finalMiniX;
        adjustedPanelX = Math.max(PANEL_PADDING, panelRect.left - diff);
      }
      
      // Сохраняем скорректированную позицию панели (для разворачивания)
      S.pos = { x: adjustedPanelX, y: panelRect.top };
      
      // Применяем финальную позицию мини-панели (гарантированно в пределах экрана)
      setElPos(UI.mini, finalMiniX, finalMiniY);
    }
    
    // ✅ при разворачивании позиционируем панель так, чтобы её правый край был там, где была мини-панель
    if (!val) {
      // Получаем текущую позицию мини-панели ДО того, как она скроется
      const miniRect = UI.mini.getBoundingClientRect();
      const miniRight = miniRect.right;
      const miniTop = miniRect.top;
      
      // Показываем панель для получения её размеров
      UI.panel.style.display = 'block';
      UI.mini.style.display = 'none';
      
      // Небольшая задержка для рендеринга, затем позиционируем
      requestAnimationFrame(() => {
        // Вычисляем позицию большой панели: её правый край = правый край мини-панели
        const panelPos = calcPanelPosFromMini(miniRight, miniTop);
        const panelSize = getElSize(UI.panel);
        
        // Проверяем границы экрана
        const minX = PANEL_PADDING;
        const maxX = window.innerWidth - panelSize.width - PANEL_PADDING;
        
        // Ограничиваем позицию в пределах экрана
        const clampedX = clamp(panelPos.x, minX, maxX);
        
        // Сохраняем и применяем позицию
        S.pos = { x: clampedX, y: panelPos.y };
        setElPos(UI.panel, clampedX, panelPos.y);
        
        // Синхронизируем мини-панель (используем offsetWidth для скрытого элемента, проверяем границы)
        syncMiniToPanel(clampedX, panelPos.y, true);
      });
    } else {
      // При сворачивании просто меняем display
      UI.panel.style.display = 'none';
      UI.mini.style.display = 'inline-flex';
    }

    updateActiveHighlight();
    updateZonesBoxes();
    updateDrawBox();
  }

  function applyThreshold(v, statusMsg) {
    S.thr = clampThr(v);
    UI.sliderThr.value = String(S.thr);
    localStorage.setItem(LS_KEYS.thr, String(S.thr));
    if (statusMsg) S.status = statusMsg;
    refreshUI(true);
  }

  function applyOpacity(v, statusMsg) {
    S.opacity = clampOpa(v);
    UI.sliderOpa.value = String(S.opacity);
    UI.overlay.style.opacity = String(S.opacity);
    localStorage.setItem(LS_KEYS.opa, String(S.opacity));
    if (statusMsg) S.status = statusMsg;
    refreshUI(true);
  }

  // Сброс состояния отслеживания (используется при изменении зон, видео и т.д.)
  function resetTrackingState() {
    S.prev = null;
    S.ref = null;
    S.refCounter = 0;
  }

  function saveZones(statusMsg) {
    S.zones = sanitizeZones(S.zones);
    setLSJSON(LS_KEYS.zones, S.zones);

    resetTrackingState();
    clearAlarm();

    if (statusMsg) S.status = statusMsg;
    refreshUI(true);
  }

  function zonesCoveragePct(zones) {
    if (!zones.length) return 100;
    let sum = 0;
    for (const z of zones) {
      const r = sanitizeZone(z);
      sum += r.w * r.h;
    }
    return Math.round(clamp(sum, 0, 1) * 100);
  }

  function setSegActive(btn, active) {
    btn.style.background = active ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.08)';
    btn.style.borderColor = active ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.14)';
  }

  function refreshUI(force = false) {
    const now = performance.now();
    if (!force && now - S.lastUI < UI_MIN_INTERVAL) return;
    S.lastUI = now;

    setSegActive(UI.btnModeVisual, S.alarmMode === 'visual');
    setSegActive(UI.btnModeAudio,  S.alarmMode === 'audio');
    setSegActive(UI.btnModeBoth,   S.alarmMode === 'both');

    UI.audioLine.style.display = alarmHasAudio(S.alarmMode) ? 'block' : 'none';

    const opaEnabled = alarmHasVisual(S.alarmMode);
    UI.sliderOpa.disabled = !opaEnabled;
    UI.sliderOpa.style.opacity = opaEnabled ? '1' : '0.45';

    if (S.blocked) {
      setDot('blocked');
      UI.subtitle.textContent = 'БЛОКИРОВКА (CORS/tainted canvas?)';
      UI.miniText.textContent = 'Блокировка';
    } else {
      setDot(S.enabled ? 'on' : 'off');
      const pausedByUX = S.drawingZone || S.picking;

      if (!S.enabled) UI.subtitle.textContent = 'ВЫКЛ • снято с охраны';
      else if (S.calibrating) UI.subtitle.textContent = 'ВКЛ • калибровка…';
      else if (pausedByUX) UI.subtitle.textContent = 'ВКЛ • режим выбора/зон (пауза)';
      else UI.subtitle.textContent = 'ВКЛ • на охране';

      UI.miniText.textContent = S.enabled ? (S.calibrating ? 'Калибровка…' : 'Движение') : 'Отключено';
    }

    UI.modeChip.textContent = modeLabelFromThr(S.thr);
    UI.metaLeft.textContent = `порог=${S.thr.toFixed(2)} • режим=${UI.modeChip.textContent}`;
    UI.metaRight.textContent = `Δ=${S.d.toFixed(2)} (пред=${S.dPrev.toFixed(2)} опорн=${S.dRef.toFixed(2)})`;

    UI.opaRight.textContent = `прозр=${S.opacity.toFixed(2)}`;
    UI.opaChip.textContent = `${Math.round(S.opacity * 100)}%`;

    UI.audioRight.textContent = `звук: ${Audio.unlocked ? 'разрешён' : 'заблокирован'}`;
    UI.volChip.textContent = `${Math.round((S.volume / VOL.max) * 100)}%`;

    const mode = S.manualVideo ? 'ручной выбор' : (TARGET_SELECTOR === 'auto' ? 'auto' : TARGET_SELECTOR);
    const selLabel = S.video ? `${mode}(видео найдено)` : `${mode}(ожидание)`;

    const n = S.zones.length;
    const cover = zonesCoveragePct(S.zones);
    const zonesLabel = n ? `зоны=${n} (≈${cover}%)` : 'зоны=нет (всё видео)';

    const reactLabel =
      S.alarmMode === 'visual' ? 'тревога=визуал' :
      S.alarmMode === 'audio'  ? 'тревога=звук' :
      'тревога=оба';

    UI.footerLeft.textContent =
      `${selLabel} • ${zonesLabel} • ${reactLabel}${S.status ? ' • ' + S.status : ''}`;

    const videoNotReady = !isValidVideo(S.video) || S.video.paused || S.video.ended;
    setBtnDisabled(UI.btnAuto, videoNotReady || S.blocked || S.calibrating || S.drawingZone || S.picking);
    setBtnDisabled(UI.btnReset, S.blocked || S.calibrating);

    setBtnDisabled(UI.btnPickAuto, (TARGET_SELECTOR !== 'auto') || S.calibrating || !!S.manualVideo);
    setBtnDisabled(UI.btnPipette, S.calibrating || S.blocked || S.drawingZone);

    setBtnDisabled(UI.btnZoneAdd, !isValidVideo(S.video) || S.blocked || S.calibrating || S.picking || S.drawingZone || S.zones.length >= ZONES_MAX);
    setBtnDisabled(UI.btnZoneUndo, S.blocked || S.calibrating || S.drawingZone || S.zones.length === 0);
    setBtnDisabled(UI.btnZoneClear, S.blocked || S.calibrating || S.drawingZone || S.zones.length === 0);

    UI.btnBackAuto.style.display = S.manualVideo ? 'block' : 'none';

    updateActiveHighlight();
    updateZonesBoxes();
    updateDrawBox();
  }

  // =========================
  // PICK VIDEO BY CLICK
  // =========================
  function getVideoFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    if (el.tagName === 'VIDEO') return el;
    return el.closest?.('video') || el.querySelector?.('video') || null;
  }

  function stopPicking(msg) {
    if (!S.picking) return;
    S.picking = false;

    hideBox(UI.pickBox);
    document.documentElement.style.cursor = '';

    document.removeEventListener('mousemove', S.pickMoveH, true);
    document.removeEventListener('click', S.pickClickH, true);
    document.removeEventListener('keydown', S.pickKeyH, true);

    clearTimeout(S.pickAutoTimer);
    S.pickAutoTimer = 0;

    S.pickMoveH = S.pickClickH = S.pickKeyH = null;
    S.pickTarget = null;
    S.pickHoverSeen = false;

    if (msg) S.status = msg;
    refreshUI(true);
  }

  function startPicking() {
    if (S.picking || S.blocked || S.calibrating || S.drawingZone) return;

    S.picking = true;
    S.pickHoverSeen = false;
    S.status = 'выбор видео: наведи на видео и кликни (Esc — отмена)';
    document.documentElement.style.cursor = 'crosshair';

    hideBox(UI.activeBox);

    const initial = resolveVideo();
    S.pickTarget = initial;

    const placePick = (v) => {
      if (!v || !document.contains(v)) return hideBox(UI.pickBox);
      const r = v.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return hideBox(UI.pickBox);
      placeBoxAbs(UI.pickBox, r.left, r.top, r.width, r.height);
    };

    placePick(initial);

    clearTimeout(S.pickAutoTimer);
    S.pickAutoTimer = setTimeout(() => {
      if (!S.picking || S.pickHoverSeen) return;
      const mainV = resolveVideo();
      S.pickTarget = mainV;
      placePick(mainV);
      S.status = 'подсветил главное видео — кликни (Esc — отмена)';
      refreshUI(true);
    }, PICKER_AUTO_HIGHLIGHT_MS);

    S.pickMoveH = (e) => {
      const v = getVideoFromPoint(e.clientX, e.clientY);
      if (v) {
        S.pickHoverSeen = true;
        S.pickTarget = v;
        placePick(v);
      }
    };

    S.pickClickH = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const v = S.pickTarget || getVideoFromPoint(e.clientX, e.clientY);
      if (!v) { S.status = 'не вижу видео под курсором'; return refreshUI(true); }

      S.manualVideo = v;
      S.video = v;

      resetTrackingState();
      clearAlarm();

      stopPicking('видео выбрано');
      restartLoop();
    };

    S.pickKeyH = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stopPicking('выбор отменён');
      }
    };

    document.addEventListener('mousemove', S.pickMoveH, true);
    document.addEventListener('click', S.pickClickH, true);
    document.addEventListener('keydown', S.pickKeyH, true);

    refreshUI(true);
  }

  // =========================
  // DRAW ZONE (add)
  // =========================
  function stopZoneDraw(msg) {
    if (!S.drawingZone) return;
    S.drawingZone = false;

    document.documentElement.style.cursor = '';

    document.removeEventListener('mousedown', S.zDownH, true);
    document.removeEventListener('mousemove', S.zMoveH, true);
    document.removeEventListener('mouseup',   S.zUpH, true);
    document.removeEventListener('keydown',   S.zKeyH, true);

    S.zDownH = S.zMoveH = S.zUpH = S.zKeyH = null;
    S.drawDrag = null;

    hideBox(UI.drawBox);

    if (msg) S.status = msg;
    refreshUI(true);
  }

  function startZoneDraw() {
    if (!S.video || S.blocked || S.calibrating || S.picking || S.drawingZone) return;
    if (S.zones.length >= ZONES_MAX) { S.status = `лимит зон (${ZONES_MAX})`; return refreshUI(true); }

    S.drawingZone = true;
    clearAlarm();
    S.status = 'добавление зоны: потяни прямоугольник по видео (Esc — отмена)';
    document.documentElement.style.cursor = 'crosshair';

    hideBox(UI.activeBox);

    S.zDownH = (e) => {
      if (e.button !== 0) return;
      if (!isValidVideo(S.video)) return;

      const vr = S.video.getBoundingClientRect();
      const inside = (e.clientX >= vr.left && e.clientX <= vr.right && e.clientY >= vr.top && e.clientY <= vr.bottom);
      if (!inside) return;

      e.preventDefault();
      e.stopPropagation();

      S.drawDrag = { startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY, vr };
      updateDrawBox();
    };

    S.zMoveH = (e) => {
      if (!S.drawDrag) return;
      S.drawDrag.curX = e.clientX;
      S.drawDrag.curY = e.clientY;
      updateDrawBox();
    };

    S.zUpH = (e) => {
      if (!S.drawDrag || !S.video) return;

      e.preventDefault();
      e.stopPropagation();

      const vr = S.drawDrag.vr;
      const xA = clamp(S.drawDrag.startX, vr.left, vr.right);
      const yA = clamp(S.drawDrag.startY, vr.top, vr.bottom);
      const xB = clamp(S.drawDrag.curX,   vr.left, vr.right);
      const yB = clamp(S.drawDrag.curY,   vr.top, vr.bottom);

      const left = Math.min(xA, xB);
      const top  = Math.min(yA, yB);
      const wPx  = Math.abs(xB - xA);
      const hPx  = Math.abs(yB - yA);

      if (wPx < ZONE_MIN_PX || hPx < ZONE_MIN_PX) {
        stopZoneDraw('зона слишком маленькая');
        return;
      }

      const zone = sanitizeZone({
        x: (left - vr.left) / vr.width,
        y: (top  - vr.top)  / vr.height,
        w: wPx / vr.width,
        h: hPx / vr.height,
      });

      S.zones.push(zone);
      saveZones(`зона добавлена (${S.zones.length}/${ZONES_MAX})`);
      stopZoneDraw();
      updateZonesBoxes();
    };

    S.zKeyH = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stopZoneDraw('добавление зоны отменено');
      }
    };

    document.addEventListener('mousedown', S.zDownH, true);
    document.addEventListener('mousemove', S.zMoveH, true);
    document.addEventListener('mouseup',   S.zUpH, true);
    document.addEventListener('keydown',   S.zKeyH, true);

    refreshUI(true);
  }

  // =========================
  // AUTO CAL
  // =========================
  async function autoCalibrate() {
    if (!S.video || S.blocked || S.calibrating) {
      S.status = !S.video ? 'нет видео' : (S.blocked ? 'canvas заблокирован' : 'уже калибруется');
      return refreshUI(true);
    }
    if (S.video.paused || S.video.ended || S.video.readyState < 2) {
      S.status = 'запусти видео (▶)';
      return refreshUI(true);
    }

    const videoAtStart = S.video;
    const boundsList = zonesToSampleBounds(S.zones);

    S.calibrating = true;
    clearAlarm();
    S.status = `калибровка: 0/${CAL.samples}`;
    refreshUI(true);

    try {
      const diffs = [];
      let prev = new Uint8ClampedArray(captureFrame());
      let stalls = 0;

      for (let i = 0; i < CAL.samples; i++) {
        if (S.video !== videoAtStart) break;

        const ok = await nextFrame(CAL.frameWaitMs);
        if (!ok) {
          stalls++;
          await sleep(CAL.fallbackSampleMs);
          if (stalls >= CAL.maxStalls) break;
        }

        if (S.video.paused || S.video.ended) break;

        const curr = new Uint8ClampedArray(captureFrame());
        const d = motionAcrossZones(curr, prev, boundsList);

        if (isFiniteNum(d) && d >= 0) diffs.push(d);
        prev = curr;

        if (diffs.length >= 12 && diffs.length % CAL.uiUpdateEvery === 0) {
          const thrTmp = computeAutoThreshold(diffs);
          applyThreshold(thrTmp, `калибровка: ${diffs.length}/${CAL.samples} • авто≈${thrTmp.toFixed(2)}`);
        } else if (i % 12 === 0) {
          S.status = `калибровка: ${diffs.length}/${CAL.samples}`;
          refreshUI();
        }
      }

      const clean = diffs.filter(x => isFiniteNum(x) && x >= 0);
      if (clean.length < CAL.minUsefulSamples) {
        S.status = `калибровка не удалась: мало данных (${clean.length})`;
        return refreshUI(true);
      }

      const maxD = Math.max(...clean);
      if (maxD < 0.005) {
        const thr = clampThr(Math.max(THR.min, 0.03));
        applyThreshold(thr, `авто: почти статично • порог=${thr.toFixed(2)}`);
      } else {
        const thr = computeAutoThreshold(clean);
        applyThreshold(thr, `авто: порог=${thr.toFixed(2)}`);
      }
    } catch (err) {
      S.blocked = true;
      S.enabled = false;
      clearAlarm();
      S.status = 'ошибка автокалибровки (CORS/tainted canvas?)';
      console.error('[MotionWatch] AutoCalibrate ERROR:', err);
    } finally {
      S.calibrating = false;
      resetTrackingState();
      refreshUI(true);
    }
  }

  // =========================
  // MAIN LOOP
  // =========================
  async function loop() {
    S.stop = false;

    while (!S.stop) {
      if (!isValidVideo(S.video)) {
        S.video = resolveVideo();
        resetTrackingState();
        S.status = isValidVideo(S.video) ? 'видео найдено' : 'ожидание <video>…';
        refreshUI(true);
        updateZonesBoxes();
      }

      if (!isValidVideo(S.video)) { await sleep(200); continue; }

      const pausedByUX = S.picking || S.drawingZone;
      if (!S.enabled || S.blocked || S.calibrating || pausedByUX) { await sleep(90); continue; }

      if (S.video.paused || S.video.ended || S.video.readyState < 2) { await sleep(140); continue; }

      const ok = await nextFrame(800);
      if (!ok) { refreshUI(); continue; }

      const boundsList = zonesToSampleBounds(S.zones);

      try {
        const curr = captureFrame();

        if (!S.prev) {
          S.prev = new Uint8ClampedArray(curr);
          S.ref  = new Uint8ClampedArray(curr);
          S.refCounter = 0;
          refreshUI(true);
          continue;
        }

        const currArr = new Uint8ClampedArray(curr);

        S.dPrev = motionAcrossZones(currArr, S.prev, boundsList);
        S.dRef  = S.ref ? motionAcrossZones(currArr, S.ref, boundsList) : S.dPrev;
        S.d     = Math.max(S.dPrev, S.dRef);

        if (S.d > S.thr) showAlarm();

        S.prev = currArr;

        if (!S.alarm) {
          S.refCounter++;
          if (S.refCounter >= REF_UPDATE_EVERY) {
            S.ref = currArr;
            S.refCounter = 0;
          }
        }

        refreshUI();
      } catch (err) {
        S.blocked = true;
        S.enabled = false;
        clearAlarm();
        S.status = 'ошибка: блокировка canvas (CORS/tainted?)';
        console.error('[MotionWatch] Canvas blocked:', err);
        refreshUI(true);
      }
    }
  }

  function restartLoop() {
    S.stop = true;
    setTimeout(() => {
      resetTrackingState();
      loop();
    }, 0);
  }

  // =========================
  // OBSERVE / VIEWPORT
  // =========================
  function bindOrWait() {
    S.video = resolveVideo();
    S.status = S.video ? 'видео найдено' : 'ожидание <video>…';
    refreshUI(true);
    restartLoop();

    if (S.mo) S.mo.disconnect();
    S.mo = new MutationObserver(() => {
      if (S.manualVideo && document.contains(S.manualVideo)) return;
      if (S.video && document.contains(S.video)) return;

      const v = resolveVideo();
      if (v) {
        S.video = v;
        resetTrackingState();
        S.status = 'видео найдено';
        refreshUI(true);
        updateZonesBoxes();
      }
    });
    S.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  S.onViewportChange = () => {
    refreshUI(true);
    updateZonesBoxes();
    updateDrawBox();
    if (S.pos) applyPos(S.pos.x, S.pos.y, false);
  };
  window.addEventListener('resize', S.onViewportChange, { passive: true });
  window.addEventListener('scroll', S.onViewportChange, { passive: true, capture: true });

  // =========================
  // EVENTS
  // =========================
  UI.sliderThr.addEventListener('input', () => applyThreshold(UI.sliderThr.value, `ручной порог=${clampThr(UI.sliderThr.value).toFixed(2)}`));
  UI.sliderOpa.addEventListener('input', () => applyOpacity(UI.sliderOpa.value, `прозрачность=${clampOpa(UI.sliderOpa.value).toFixed(2)}`));
  UI.sliderVol.addEventListener('input', () => applyVolume(UI.sliderVol.value, `громкость=${clampVol(UI.sliderVol.value).toFixed(2)}`));

  UI.btnAuto.addEventListener('click', autoCalibrate);
  UI.btnReset.addEventListener('click', () => applyThreshold(THR.def, `сброс: порог=${THR.def.toFixed(2)}`));

  UI.btnModeVisual.addEventListener('click', () => applyAlarmMode('visual', 'реакция: только визуал'));
  UI.btnModeAudio.addEventListener('click', async () => {
    applyAlarmMode('audio', 'реакция: только звук');
    if (!Audio.unlocked) await Audio.unlock();
    refreshUI(true);
  });
  UI.btnModeBoth.addEventListener('click', async () => {
    applyAlarmMode('both', 'реакция: визуал+звук');
    if (!Audio.unlocked) await Audio.unlock();
    refreshUI(true);
  });

  UI.btnPickAuto.addEventListener('click', () => {
    if (TARGET_SELECTOR !== 'auto' || S.calibrating || S.manualVideo) return;
    S.video = pickVideoAuto();
    resetTrackingState();
    clearAlarm();
    S.status = S.video ? 'видео перевыбрано' : 'видео не найдено';
    refreshUI(true);
    restartLoop();
  });

  UI.btnPipette.addEventListener('click', startPicking);

  UI.btnBackAuto.addEventListener('click', () => {
    if (S.picking) stopPicking();
    if (S.drawingZone) stopZoneDraw();

    S.manualVideo = null;
    S.video = resolveVideo();
    resetTrackingState();
    clearAlarm();
    S.status = 'возврат к авто-выбору';
    refreshUI(true);
    restartLoop();
  });

  UI.btnZoneAdd.addEventListener('click', startZoneDraw);

  UI.btnZoneUndo.addEventListener('click', () => {
    if (!S.zones.length) return;
    S.zones.pop();
    saveZones(S.zones.length ? `удалена последняя зона (осталось ${S.zones.length})` : 'зон нет — отслеживается всё видео');
    updateZonesBoxes();
  });

  UI.btnZoneClear.addEventListener('click', () => {
    S.zones = [];
    saveZones('зоны очищены — отслеживается всё видео');
    updateZonesBoxes();
  });

  UI.btnMin.addEventListener('click', () => applyMinimized(true));
  UI.mini.addEventListener('click', () => {
    if (S.dragMoved) return;
    applyMinimized(false);
  });
  UI.btnClose.addEventListener('click', () => window.__videoMotionWatch.destroy());

  // =========================
  // AUDIO UNLOCK (user gesture)
  // =========================
  S.audioUnlockKeyH = async (e) => {
    if (isTypingTarget(e.target)) return;
    if (Audio.unlocked) return;
    await Audio.unlock();
    refreshUI(true);
  };
  S.audioUnlockPtrH = async () => {
    if (Audio.unlocked) return;
    await Audio.unlock();
    refreshUI(true);
  };
  document.addEventListener('keydown', S.audioUnlockKeyH, true);
  document.addEventListener('pointerdown', S.audioUnlockPtrH, true);

  // =========================
  // KEYBOARD (hotkeys)
  // =========================
  S.keyH = (e) => {
    const code = e.code;
    if (!TOGGLE_CODES.has(code) && !CLEAR_CODES.has(code)) return;
    if (isTypingTarget(e.target)) return;
    if (S.drawingZone || S.picking) return;

    e.preventDefault();
    e.stopPropagation();

    if (TOGGLE_CODES.has(code)) {
      S.enabled = !S.enabled;
      clearAlarm();
      resetTrackingState();
      S.status = S.enabled ? 'включено' : 'выключено';
      refreshUI(true);
    }

    if (CLEAR_CODES.has(code)) {
      clearAlarm();
      if (S.prev) S.ref = new Uint8ClampedArray(S.prev);
      S.refCounter = 0;
      S.status = 'тревога сброшена';
      refreshUI(true);
    }
  };
  document.addEventListener('keydown', S.keyH, true);

  // =========================
  // DRAG + DBLCLICK RESET
  // =========================
  function enableDragUI() {
    initPosOnce();

    // ручки
    UI.header.style.cursor = 'move';
    UI.mini.style.cursor = 'move';

    S.dragCleanupPanel = attachDrag(UI.header);
    S.dragCleanupMini  = attachDrag(UI.mini);

    // ✅ двойной клик по шапке = вернуть в правый верхний угол
    S.headerDblH = (e) => {
      // не мешаем кнопкам закрытия/свернуть
      if (e.target?.closest?.('button')) return;
      setPosTopRight(true);
    };
    UI.header.addEventListener('dblclick', S.headerDblH, { passive: true });
  }

  // =========================
  // PUBLIC API
  // =========================
  window.__videoMotionWatch = {
    destroy() {
      S.stop = true;
      if (S.mo) S.mo.disconnect();

      if (S.picking) stopPicking();
      if (S.drawingZone) stopZoneDraw();

      window.removeEventListener('resize', S.onViewportChange);
      window.removeEventListener('scroll', S.onViewportChange, true);

      document.removeEventListener('keydown', S.audioUnlockKeyH, true);
      document.removeEventListener('pointerdown', S.audioUnlockPtrH, true);
      document.removeEventListener('keydown', S.keyH, true);

      try { S.dragCleanupPanel?.(); } catch {}
      try { S.dragCleanupMini?.(); } catch {}
      try { if (S.headerDblH) UI.header.removeEventListener('dblclick', S.headerDblH); } catch {}

      clearAlarm();
      Audio.destroy();

      UI.overlay.remove();
      UI.activeBox.remove();
      UI.zonesLayer.remove();
      UI.drawBox.remove();
      UI.pickBox.remove();
      UI.panel.remove();
      UI.mini.remove();

      delete window.__videoMotionWatch;
    },
    debug() {
      return {
        enabled: S.enabled,
        blocked: S.blocked,
        calibrating: S.calibrating,
        alarm: S.alarm,
        alarmMode: S.alarmMode,
        volume: S.volume,
        audioUnlocked: Audio.unlocked,
        thr: S.thr,
        opacity: S.opacity,
        minimized: S.minimized,
        manualVideo: !!S.manualVideo,
        zones: S.zones,
        d: S.d, dPrev: S.dPrev, dRef: S.dRef,
        video: S.video,
        status: S.status,
        pos: S.pos,
      };
    }
  };

  // =========================
  // INIT
  // =========================
  applyOpacity(S.opacity);
  applyThreshold(S.thr);
  applyVolume(S.volume);
  applyAlarmMode(S.alarmMode);
  applyMinimized(S.minimized);

  S.zones = sanitizeZones(S.zones);
  setLSJSON(LS_KEYS.zones, S.zones);

  enableDragUI();

  refreshUI(true);
  bindOrWait();
  updateZonesBoxes();

  console.log('✅ MotionWatch v21: sticky header + draggable panel/mini + dblclick reset.');
})();
