1→import { AnimatePresence, motion } from 'framer-motion';
2→import {
3→  memo,
4→  useCallback,
5→  useEffect,
6→  useId,
7→  useMemo,
8→  useRef,
9→  useState,
10→} from 'react';
11→import type { CSSProperties } from 'react';
12→import birdFlyUrl from '../../assets/companions/BirdFly.png';
13→import frogIdleUrl from '../../assets/companions/FrogIdle.png';
14→import goldenBarkingUrl from '../../assets/companions/GoldenBarking.png';
15→import jumpCatUrl from '../../assets/companions/JumpCattt.png';
16→import rabbitJumpUrl from '../../assets/companions/Jumping.png';
17→import pigIdleUrl from '../../assets/companions/PigIdle.png';
18→import sleepDogUrl from '../../assets/companions/SleepDog.png';
19→import batAttack1Url from '../../assets/companions/bat/Bat-Attack1.png';
20→import batAttack2Url from '../../assets/companions/bat/Bat-Attack2.png';
21→import batDieUrl from '../../assets/companions/bat/Bat-Die.png';
22→import batHurtUrl from '../../assets/companions/bat/Bat-Hurt.png';
23→import batIdleFlyUrl from '../../assets/companions/bat/Bat-IdleFly.png';
24→import batRunUrl from '../../assets/companions/bat/Bat-Run.png';
25→import batSleepUrl from '../../assets/companions/bat/Bat-Sleep.png';
26→import batWakeUpUrl from '../../assets/companions/bat/Bat-WakeUp.png';
27→import { cn } from '../ui';
28→import type {
29→  CompanionRarity,
30→  CompanionSpecies,
31→  CompanionState,
32→} from './types';
33→import { RARITY_COLORS, RARITY_STARS } from './types';
34→
35→type ToneKey =
36→  | 'body'
37→  | 'bodyLight'
38→  | 'bodyDark'
39→  | 'belly'
40→  | 'accent'
41→  | 'accentLight'
42→  | 'accentDark'
43→  | 'line'
44→  | 'face'
45→  | 'cheek';
46→
47→type PaintToken =
48→  | ToneKey
49→  | 'rarity'
50→  | 'none'
51→  | 'bodyGradient'
52→  | 'accentGradient'
53→  | 'rarityGradient'
54→  | (string & {});
55→
56→type Palette = Record<ToneKey, string>;
57→
58→type LayerMotion =
59→  | 'none'
60→  | 'breathe'
61→  | 'bob'
62→  | 'sway'
63→  | 'tail'
64→  | 'wing'
65→  | 'pulse'
66→  | 'tentacle'
67→  | 'antenna';
68→
69→type BaseLayer = {
70→  id: string;
71→  fill?: PaintToken;
72→  stroke?: PaintToken;
73→  strokeWidth?: number;
74→  opacity?: number;
75→  motion?: LayerMotion;
76→  origin?: string;
77→  delay?: number;
78→  linecap?: 'butt' | 'round' | 'square';
79→  linejoin?: 'round' | 'miter' | 'bevel';
80→  filter?: 'softGlow' | 'inkShadow';
81→};
82→
83→type EllipseLayer = BaseLayer & {
84→  kind: 'ellipse';
85→  cx: number;
86→  cy: number;
87→  rx: number;
88→  ry: number;
89→};
90→
91→type CircleLayer = BaseLayer & {
92→  kind: 'circle';
93→  cx: number;
94→  cy: number;
95→  r: number;
96→};
97→
98→type RectLayer = BaseLayer & {
99→  kind: 'rect';
100→  x: number;
101→  y: number;
102→  width: number;
103→  height: number;
104→  rx?: number;
105→};
106→
107→type PathLayer = BaseLayer & {
108→  kind: 'path';
109→  d: string;
110→};
111→
112→type PolygonLayer = BaseLayer & {
113→  kind: 'polygon';
114→  points: string;
115→};
116→
117→type LineLayer = BaseLayer & {
118→  kind: 'line';
119→  x1: number;
120→  y1: number;
121→  x2: number;
122→  y2: number;
123→};
124→
125→type SpriteLayer =
126→  | EllipseLayer
127→  | CircleLayer
128→  | RectLayer
129→  | PathLayer
130→  | PolygonLayer
131→  | LineLayer;
132→
133→type EyeRig = {
134→  left: { cx: number; cy: number; rx: number; ry: number };
135→  right: { cx: number; cy: number; rx: number; ry: number };
136→  fill?: PaintToken;
137→  highlight?: boolean;
138→  glow?: boolean;
139→};
140→
141→type MouthRig = {
142→  idle: string;
143→  speaking: string;
144→  sleeping?: string;
145→  stroke?: PaintToken;
146→  strokeWidth?: number;
147→  fill?: PaintToken;
148→};
149→
150→type BuddyBlueprint = {
151→  name: string;
152→  palette: Palette;
153→  layers: SpriteLayer[];
154→  eyes: EyeRig;
155→  mouth: MouthRig;
156→  shadow?: { cx: number; cy: number; rx: number; ry: number };
157→};
158→
159→type PixelSpriteSheet = {
160→  src: string;
161→  label: string;
162→  frameWidth: number;
163→  frameHeight: number;
164→  frames: number;
165→  fps: number;
166→  scale: number;
167→  y?: number;
168→  states?: Partial<Record<PixelSpriteState, PixelSpriteAnimation>>;
169→};
170→
171→type PixelSpriteState =
172→  | 'idle'
173→  | 'speaking'
174→  | 'petting'
175→  | 'sleeping'
176→  | 'run'
177→  | 'hurt'
178→  | 'die'
179→  | 'wakeUp';
180→
181→type PixelSpriteAnimation = {
182→  src: string;
183→  frameWidth: number;
184→  frameHeight: number;
185→  frames: number;
186→  fps: number;
187→};
188→
189→type SpriteMood = {
190→  isSpeaking: boolean;
191→  isPetting: boolean;
192→  isSleeping: boolean;
193→  mood: string;
194→};
195→
196→type SpriteFrame = {
197→  y: number;
198→  rotate: number;
199→  scale: number;
200→  opacity?: number;
201→};
202→
203→type HeartBurst = {
204→  id: number;
205→  x: number;
206→  scale: number;
207→};
208→
209→type SpriteIds = {
210→  body: string;
211→  accent: string;
212→  rarity: string;
213→  softGlow: string;
214→  inkShadow: string;
215→  rim: string;
216→  glass: string;
217→  stripe: string;
218→};
219→
220→const IDLE_FRAMES: SpriteFrame[] = [
221→  { y: 0, rotate: 0, scale: 1 },
222→  { y: -2, rotate: -0.4, scale: 1.006 },
223→  { y: -3.5, rotate: 0, scale: 1.012 },
224→  { y: -2, rotate: 0.4, scale: 1.006 },
225→  { y: 0, rotate: 0, scale: 1 },
226→];
227→
228→const EXCITED_FRAMES: SpriteFrame[] = [
229→  { y: -5, rotate: -2.2, scale: 1.035 },
230→  { y: -9, rotate: 2.2, scale: 1.065 },
231→  { y: -3, rotate: -1.4, scale: 1.02 },
232→  { y: -7, rotate: 1.4, scale: 1.05 },
233→  { y: -1, rotate: 0, scale: 1.012 },
234→];
235→
236→const SLEEP_FRAMES: SpriteFrame[] = [
237→  { y: 0, rotate: 0, scale: 1, opacity: 1 },
238→  { y: 0.8, rotate: 0, scale: 0.988, opacity: 0.94 },
239→  { y: 1.6, rotate: 0, scale: 0.978, opacity: 0.88 },
240→  { y: 0.8, rotate: 0, scale: 0.988, opacity: 0.94 },
241→  { y: 0, rotate: 0, scale: 1, opacity: 1 },
242→];
243→
244→const DEFAULT_SHADOW = { cx: 50, cy: 82, rx: 28, ry: 5 };
245→const HEART_PATH =
246→  'M50 82 C24 62 16 47 22 34 C28 20 43 24 50 36 C57 24 72 20 78 34 C84 47 76 62 50 82 Z';
247→const EASE_IN_OUT = 'easeInOut' as const;
248→const PREMIUM_ART_SPECIES = new Set<CompanionSpecies>([
249→  'duck',
250→  'goose',
251→  'blob',
252→  'cat',
253→  'dragon',
254→  'bat',
255→  'octopus',
256→  'owl',
257→  'penguin',
258→  'turtle',
259→  'snail',
260→  'ghost',
261→  'axolotl',
262→  'capybara',
263→  'cactus',
264→  'robot',
265→  'rabbit',
266→  'mushroom',
267→  'chonk',
268→]);
269→
270→const PIXEL_SPRITES: Partial<Record<CompanionSpecies, PixelSpriteSheet>> = {
271→  duck: {
272→    src: birdFlyUrl,
273→    label: 'bird',
274→    frameWidth: 16,
275→    frameHeight: 16,
276→    frames: 8,
277→    fps: 9,
278→    scale: 4.2,
279→    y: 8,
280→  },
281→  dragon: {
282→    src: frogIdleUrl,
283→    label: 'frog',
284→    frameWidth: 32,
285→    frameHeight: 32,
286→    frames: 4,
287→    fps: 5,
288→    scale: 2.7,
289→    y: 2,
290→  },
291→  bat: {
292→    src: batIdleFlyUrl,
293→    label: 'bat',
294→    frameWidth: 64,
295→    frameHeight: 64,
296→    frames: 9,
297→    fps: 10,
298→    scale: 2.7,
299→    y: -1,
300→    states: {
301→      idle: {
302→        src: batIdleFlyUrl,
303→        frameWidth: 64,
304→        frameHeight: 64,
305→        frames: 9,
306→        fps: 10,
307→      },
308→      speaking: {
309→        src: batAttack2Url,
310→        frameWidth: 64,
311→        frameHeight: 64,
312→        frames: 11,
313→        fps: 13,
314→      },
315→      petting: {
316→        src: batAttack1Url,
317→        frameWidth: 64,
318→        frameHeight: 64,
319→        frames: 8,
320→        fps: 12,
321→      },
322→      sleeping: {
323→        src: batSleepUrl,
324→        frameWidth: 64,
325→        frameHeight: 64,
326→        frames: 3,
327→        fps: 3,
328→      },
329→      run: {
330→        src: batRunUrl,
331→        frameWidth: 64,
332→        frameHeight: 64,
333→        frames: 8,
334→        fps: 11,
335→      },
336→      hurt: {
337→        src: batHurtUrl,
338→        frameWidth: 64,
339→        frameHeight: 64,
340→        frames: 5,
341→        fps: 10,
342→      },
343→      die: {
344→        src: batDieUrl,
345→        frameWidth: 64,
346→        frameHeight: 64,
347→        frames: 12,
348→        fps: 11,
349→      },
350→      wakeUp: {
351→        src: batWakeUpUrl,
352→        frameWidth: 64,
353→        frameHeight: 64,
354→        frames: 16,
355→        fps: 12,
356→      },
357→    },
358→  },
359→  capybara: {
360→    src: goldenBarkingUrl,
361→    label: 'golden dog',
362→    frameWidth: 64,
363→    frameHeight: 64,
364→    frames: 11,
365→    fps: 8,
366→    scale: 1.65,
367→    y: 2,
368→  },
369→  cat: {
370→    src: jumpCatUrl,
371→    label: 'cat',
372→    frameWidth: 32,
373→    frameHeight: 32,
374→    frames: 13,
375→    fps: 10,
376→    scale: 2.75,
377→    y: 2,
378→  },
379→  rabbit: {
380→    src: rabbitJumpUrl,
381→    label: 'rabbit',
382→    frameWidth: 32,
383→    frameHeight: 32,
384→    frames: 11,
385→    fps: 10,
386→    scale: 2.7,
387→    y: 2,
388→  },
389→  chonk: {
390→    src: pigIdleUrl,
391→    label: 'pig',
392→    frameWidth: 64,
393→    frameHeight: 64,
394→    frames: 4,
395→    fps: 5,
396→    scale: 1.75,
397→    y: 2,
398→  },
399→  ghost: {
400→    src: sleepDogUrl,
401→    label: 'sleeping dog',
402→    frameWidth: 64,
403→    frameHeight: 64,
404→    frames: 8,
405→    fps: 6,
406→    scale: 1.65,
407→    y: 2,
408→  },
409→};
410→
411→export function getCompanionSpriteLabel(species: CompanionSpecies) {
412→  return PIXEL_SPRITES[species]?.label ?? species;
413→}
414→
415→const l = {
416→  ellipse: (
417→    id: string,
418→    cx: number,
419→    cy: number,
420→    rx: number,
421→    ry: number,
422→    fill: PaintToken,
423→    extra: Partial<EllipseLayer> = {},
424→  ): EllipseLayer => ({ kind: 'ellipse', id, cx, cy, rx, ry, fill, ...extra }),
425→  circle: (
426→    id: string,
427→    cx: number,
428→    cy: number,
429→    r: number,
430→    fill: PaintToken,
431→    extra: Partial<CircleLayer> = {},
432→  ): CircleLayer => ({ kind: 'circle', id, cx, cy, r, fill, ...extra }),
433→  rect: (
434→    id: string,
435→    x: number,
436→    y: number,
437→    width: number,
438→    height: number,
439→    rx: number,
440→    fill: PaintToken,
441→    extra: Partial<RectLayer> = {},
442→  ): RectLayer => ({
443→    kind: 'rect',
444→    id,
445→    x,
446→    y,
447→    width,
448→    height,
449→    rx,
450→    fill,
451→    ...extra,
452→  }),
453→  path: (
454→    id: string,
455→    d: string,
456→    fill: PaintToken,
457→    extra: Partial<PathLayer> = {},
458→  ): PathLayer => ({ kind: 'path', id, d, fill, ...extra }),
459→  polygon: (
460→    id: string,
461→    points: string,
462→    fill: PaintToken,
463→    extra: Partial<PolygonLayer> = {},
464→  ): PolygonLayer => ({ kind: 'polygon', id, points, fill, ...extra }),
465→  line: (
466→    id: string,
467→    x1: number,
468→    y1: number,
469→    x2: number,
470→    y2: number,
471→    stroke: PaintToken,
472→    extra: Partial<LineLayer> = {},
473→  ): LineLayer => ({
474→    kind: 'line',
475→    id,
476→    x1,
477→    y1,
478→    x2,
479→    y2,
480→    fill: 'none',
481→    stroke,
482→    linecap: 'round',
483→    ...extra,
484→  }),
485→};
486→
487→const palettes = {
488→  cat: {
489→    body: '#cbd5e1',
490→    bodyLight: '#f8fafc',
491→    bodyDark: '#94a3b8',
492→    belly: '#f1f5f9',
493→    accent: '#fb7185',
494→    accentLight: '#fecdd3',
495→    accentDark: '#be123c',
496→    line: '#475569',
497→    face: '#0f172a',
498→    cheek: '#fda4af',
499→  },
500→  robot: {
501→    body: '#475569',
502→    bodyLight: '#94a3b8',
503→    bodyDark: '#1e293b',
504→    belly: '#0f172a',
505→    accent: '#22d3ee',
506→    accentLight: '#a5f3fc',
507→    accentDark: '#0891b2',
508→    line: '#0f172a',
509→    face: '#67e8f9',
510→    cheek: '#38bdf8',
511→  },
512→  ghost: {
513→    body: '#e2e8f0',
514→    bodyLight: '#ffffff',
515→    bodyDark: '#94a3b8',
516→    belly: '#f8fafc',
517→    accent: '#c4b5fd',
518→    accentLight: '#ede9fe',
519→    accentDark: '#7c3aed',
520→    line: '#64748b',
521→    face: '#1e293b',
522→    cheek: '#fda4af',
523→  },
524→  blob: {
525→    body: '#8b5cf6',
526→    bodyLight: '#c4b5fd',
527→    bodyDark: '#5b21b6',
528→    belly: '#ede9fe',
529→    accent: '#22d3ee',
530→    accentLight: '#a5f3fc',
531→    accentDark: '#0e7490',
532→    line: '#312e81',
533→    face: '#111827',
534→    cheek: '#f0abfc',
535→  },
536→  duck: {
537→    body: '#fbbf24',
538→    bodyLight: '#fde68a',
539→    bodyDark: '#d97706',
540→    belly: '#fef3c7',
541→    accent: '#f97316',
542→    accentLight: '#fed7aa',
543→    accentDark: '#c2410c',
544→    line: '#92400e',
545→    face: '#111827',
546→    cheek: '#fb923c',
547→  },
548→  goose: {
549→    body: '#e2e8f0',
550→    bodyLight: '#ffffff',
551→    bodyDark: '#94a3b8',
552→    belly: '#f8fafc',
553→    accent: '#ea580c',
554→    accentLight: '#fed7aa',
555→    accentDark: '#9a3412',
556→    line: '#64748b',
557→    face: '#0f172a',
558→    cheek: '#fca5a5',
559→  },
560→  dragon: {
561→    body: '#10b981',
562→    bodyLight: '#6ee7b7',
563→    bodyDark: '#047857',
564→    belly: '#fcd34d',
565→    accent: '#f59e0b',
566→    accentLight: '#fde68a',
567→    accentDark: '#b45309',
568→    line: '#064e3b',
569→    face: '#102a1f',
570→    cheek: '#fb923c',
571→  },
572→  octopus: {
573→    body: '#a855f7',
574→    bodyLight: '#d8b4fe',
575→    bodyDark: '#7e22ce',
576→    belly: '#f5d0fe',
577→    accent: '#ec4899',
578→    accentLight: '#fbcfe8',
579→    accentDark: '#be185d',
580→    line: '#581c87',
581→    face: '#111827',
582→    cheek: '#f0abfc',
583→  },
584→  owl: {
585→    body: '#78350f',
586→    bodyLight: '#b45309',
587→    bodyDark: '#451a03',
588→    belly: '#fef3c7',
589→    accent: '#fbbf24',
590→    accentLight: '#fde68a',
591→    accentDark: '#d97706',
592→    line: '#451a03',
593→    face: '#111827',
594→    cheek: '#fdba74',
595→  },
596→  penguin: {
597→    body: '#111827',
598→    bodyLight: '#374151',
599→    bodyDark: '#020617',
600→    belly: '#f8fafc',
601→    accent: '#f97316',
602→    accentLight: '#fed7aa',
603→    accentDark: '#c2410c',
604→    line: '#0f172a',
605→    face: '#020617',
606→    cheek: '#93c5fd',
607→  },
608→  turtle: {
609→    body: '#22c55e',
610→    bodyLight: '#86efac',
611→    bodyDark: '#15803d',
612→    belly: '#fef3c7',
613→    accent: '#65a30d',
614→    accentLight: '#bef264',
615→    accentDark: '#365314',
616→    line: '#14532d',
617→    face: '#111827',
618→    cheek: '#bbf7d0',
619→  },
620→  snail: {
621→    body: '#d97706',
622→    bodyLight: '#fcd34d',
623→    bodyDark: '#92400e',
624→    belly: '#fde68a',
625→    accent: '#8b5cf6',
626→    accentLight: '#c4b5fd',
627→    accentDark: '#5b21b6',
628→    line: '#78350f',
629→    face: '#111827',
630→    cheek: '#fbbf24',
631→  },
632→  axolotl: {
633→    body: '#f9a8d4',
634→    bodyLight: '#fce7f3',
635→    bodyDark: '#ec4899',
636→    belly: '#fbcfe8',
637→    accent: '#fb7185',
638→    accentLight: '#fecdd3',
639→    accentDark: '#be123c',
640→    line: '#be185d',
641→    face: '#111827',
642→    cheek: '#f472b6',
643→  },
644→  capybara: {
645→    body: '#92400e',
646→    bodyLight: '#d97706',
647→    bodyDark: '#451a03',
648→    belly: '#fcd34d',
649→    accent: '#78350f',
650→    accentLight: '#f59e0b',
651→    accentDark: '#451a03',
652→    line: '#451a03',
653→    face: '#111827',
654→    cheek: '#fbbf24',
655→  },
656→  cactus: {
657→    body: '#059669',
658→    bodyLight: '#34d399',
659→    bodyDark: '#065f46',
660→    belly: '#a7f3d0',
661→    accent: '#ec4899',
662→    accentLight: '#fbcfe8',
663→    accentDark: '#be185d',
664→    line: '#064e3b',
665→    face: '#0f172a',
666→    cheek: '#f0abfc',
667→  },
668→  rabbit: {
669→    body: '#f3f4f6',
670→    bodyLight: '#ffffff',
671→    bodyDark: '#cbd5e1',
672→    belly: '#f8fafc',
673→    accent: '#f9a8d4',
674→    accentLight: '#fce7f3',
675→    accentDark: '#db2777',
676→    line: '#64748b',
677→    face: '#111827',
678→    cheek: '#fda4af',
679→  },
680→  mushroom: {
681→    body: '#ef4444',
682→    bodyLight: '#fca5a5',
683→    bodyDark: '#b91c1c',
684→    belly: '#f8fafc',
685→    accent: '#fde68a',
686→    accentLight: '#ffffff',
687→    accentDark: '#f59e0b',
688→    line: '#7f1d1d',
689→    face: '#111827',
690→    cheek: '#fca5a5',
691→  },
692→  chonk: {
693→    body: '#d97706',
694→    bodyLight: '#f59e0b',
695→    bodyDark: '#92400e',
696→    belly: '#fef3c7',
697→    accent: '#f472b6',
698→    accentLight: '#fbcfe8',
699→    accentDark: '#be185d',
700→    line: '#78350f',
701→    face: '#111827',
702→    cheek: '#fca5a5',
703→  },
704→} satisfies Record<string, Palette>;
705→
706→const BUDDY_BLUEPRINTS: Record<CompanionSpecies, BuddyBlueprint> = {
707→  cat: {
708→    name: 'Cat',
709→    palette: palettes.cat,
710→    layers: [
711→      l.path(
712→        'tail',
713→        'M31 69 C19 66 13 56 16 43 C17 36 22 35 23 40 C20 50 25 58 34 61',
714→        'none',
715→        {
716→          stroke: 'bodyDark',
717→          strokeWidth: 5,
718→          motion: 'tail',
719→          origin: '32px 66px',
720→        },
721→      ),
722→      l.ellipse('body', 50, 61, 24, 18, 'bodyGradient', {
723→        stroke: 'bodyDark',
724→        strokeWidth: 1.4,
725→      }),
726→      l.circle('head', 50, 39, 18, 'bodyGradient', {
727→        stroke: 'bodyDark',
728→        strokeWidth: 1.2,
729→      }),
730→      l.polygon('left-ear', '34 28 24 14 31 32', 'bodyDark'),
731→      l.polygon('right-ear', '66 28 76 14 69 32', 'bodyDark'),
732→      l.polygon('left-inner-ear', '33 26 27 17 31 28', 'accentLight'),
733→      l.polygon('right-inner-ear', '67 26 73 17 69 28', 'accentLight'),
734→      l.circle('left-cheek', 38, 47, 3, 'cheek', { opacity: 0.58 }),
735→      l.circle('right-cheek', 62, 47, 3, 'cheek', { opacity: 0.58 }),
736→      l.line('whisker-l1', 32, 43, 18, 40, 'line', { strokeWidth: 1 }),
737→      l.line('whisker-l2', 31, 47, 16, 47, 'line', { strokeWidth: 1 }),
738→      l.line('whisker-r1', 68, 43, 82, 40, 'line', { strokeWidth: 1 }),
739→      l.line('whisker-r2', 69, 47, 84, 47, 'line', { strokeWidth: 1 }),
740→      l.polygon('nose', '48 44 52 44 50 47', 'accentDark'),
741→    ],
742→    eyes: {
743→      left: { cx: 41, cy: 39, rx: 3, ry: 4 },
744→      right: { cx: 59, cy: 39, rx: 3, ry: 4 },
745→      highlight: true,
746→    },
747→    mouth: {
748→      idle: 'M45 49 Q48 52 50 49 Q52 52 55 49',
749→      speaking: 'M45 49 Q50 56 55 49',
750→      stroke: 'line',
751→    },
752→  },
753→  robot: {
754→    name: 'Robot',
755→    palette: palettes.robot,
756→    layers: [
757→      l.line('antenna-stem', 50, 29, 50, 15, 'bodyLight', {
758→        strokeWidth: 3,
759→        motion: 'antenna',
760→        origin: '50px 29px',
761→      }),
762→      l.circle('antenna-node', 50, 11, 4.5, 'rarityGradient', {
763→        motion: 'pulse',
764→        filter: 'softGlow',
765→      }),
766→      l.rect('body', 29, 27, 42, 43, 8, 'bodyGradient', {
767→        stroke: 'line',
768→        strokeWidth: 2,
769→      }),
770→      l.rect('visor', 34, 34, 32, 18, 4, 'belly', {
771→        stroke: 'bodyDark',
772→        strokeWidth: 1.5,
773→      }),
774→      l.rect('left-bolt', 22, 44, 7, 10, 2, 'bodyDark'),
775→      l.rect('right-bolt', 71, 44, 7, 10, 2, 'bodyDark'),
776→      l.rect('base', 35, 68, 30, 9, 3, 'bodyDark'),
777→      l.line('panel-1', 39, 61, 61, 61, 'accent', { strokeWidth: 2 }),
778→      l.line('panel-2', 42, 65, 58, 65, 'accentDark', { strokeWidth: 1.5 }),
779→    ],
780→    eyes: {
781→      left: { cx: 42, cy: 43, rx: 3.2, ry: 3 },
782→      right: { cx: 58, cy: 43, rx: 3.2, ry: 3 },
783→      fill: 'face',
784→      glow: true,
785→    },
786→    mouth: {
787→      idle: 'M44 58 L56 58',
788→      speaking: 'M44 57 Q50 64 56 57',
789→      stroke: 'face',
790→      strokeWidth: 2.5,
791→    },
792→  },
793→  ghost: {
794→    name: 'Ghost',
795→    palette: palettes.ghost,
796→    layers: [
797→      l.path(
798→        'body',
799→        'M28 35 C28 15 72 15 72 35 L72 70 Q62 64 50 70 Q38 64 28 70 Z',
800→        'bodyGradient',
801→        {
802→          opacity: 0.92,
803→          motion: 'bob',
804→          stroke: 'bodyDark',
805→          strokeWidth: 1,
806→        },
807→      ),
808→      l.circle('left-cheek', 34, 45, 3.5, 'cheek', { opacity: 0.5 }),
809→      l.circle('right-cheek', 66, 45, 3.5, 'cheek', { opacity: 0.5 }),
810→      l.path(
811→        'hem-shine',
812→        'M33 65 Q41 60 50 66 Q59 60 67 65',
813→        'none',
814→        { stroke: 'bodyLight', strokeWidth: 1.4, opacity: 0.7 },
815→      ),
816→    ],
817→    eyes: {
818→      left: { cx: 41, cy: 39, rx: 4.5, ry: 5 },
819→      right: { cx: 59, cy: 39, rx: 4.5, ry: 5 },
820→      highlight: true,
821→    },
822→    mouth: {
823→      idle: 'M47 48 Q50 50 53 48',
824→      speaking: 'M47 48 Q50 55 53 48',
825→      stroke: 'face',
826→    },
827→  },
828→  blob: {
829→    name: 'Blob',
830→    palette: palettes.blob,
831→    layers: [
832→      l.path(
833→        'body',
834→        'M50 17 C29 18 20 55 20 68 C20 81 80 81 80 68 C80 55 71 18 50 17 Z',
835→        'bodyGradient',
836→        {
837→          stroke: 'bodyDark',
838→          strokeWidth: 1.5,
839→          motion: 'breathe',
840→          filter: 'softGlow',
841→        },
842→      ),
843→      l.path(
844→        'shine',
845→        'M42 27 C31 31 27 43 29 52 C31 44 34 34 42 27 Z',
846→        'bodyLight',
847→        { opacity: 0.46 },
848→      ),
849→      l.circle('left-cheek', 34, 59, 3, 'cheek', { opacity: 0.5 }),
850→      l.circle('right-cheek', 66, 59, 3, 'cheek', { opacity: 0.5 }),
851→    ],
852→    eyes: {
853→      left: { cx: 39, cy: 52, rx: 4.6, ry: 6 },
854→      right: { cx: 61, cy: 52, rx: 4.6, ry: 6 },
855→      highlight: true,
856→    },
857→    mouth: {
858→      idle: 'M47 63 Q50 66 53 63',
859→      speaking: 'M45 63 Q50 70 55 63',
860→      stroke: 'face',
861→      strokeWidth: 2.2,
862→    },
863→  },
864→  duck: {
865→    name: 'Duck',
866→    palette: palettes.duck,
867→    layers: [
868→      l.ellipse('waterline', 50, 75, 29, 4, '#60a5fa', { opacity: 0.25 }),
869→      l.ellipse('body', 46, 59, 24, 17, 'bodyGradient', {
870→        stroke: 'bodyDark',
871→        strokeWidth: 1,
872→      }),
873→      l.circle('head', 59, 39, 14, 'bodyGradient'),
874→      l.path('beak', 'M68 36 C77 36 79 43 68 43 Z', 'accent', {
875→        stroke: 'accentDark',
876→        strokeWidth: 1,
877→        motion: 'pulse',
878→        origin: '68px 39px',
879→      }),
880→      l.path('wing', 'M35 55 C25 50 27 64 36 61', 'none', {
881→        stroke: 'bodyDark',
882→        strokeWidth: 4,
883→        motion: 'wing',
884→        origin: '35px 55px',
885→      }),
886→    ],
887→    eyes: {
888→      left: { cx: 56, cy: 35, rx: 2.2, ry: 2.8 },
889→      right: { cx: 56, cy: 35, rx: 2.2, ry: 2.8 },
890→      highlight: true,
891→    },
892→    mouth: {
893→      idle: 'M69 42 Q72 44 75 42',
894→      speaking: 'M69 42 Q73 47 77 42',
895→      stroke: 'accentDark',
896→      strokeWidth: 1.3,
897→    },
898→  },
899→  goose: {
900→    name: 'Goose',
901→    palette: palettes.goose,
902→    layers: [
903→      l.ellipse('waterline', 50, 75, 27, 3.5, 'bodyDark', { opacity: 0.25 }),
904→      l.ellipse('body', 44, 62, 22, 15, 'bodyGradient', {
905→        stroke: 'bodyDark',
906→        strokeWidth: 1,
907→      }),
908→      l.path(
909→        'neck',
910→        'M56 63 Q66 52 60 38 L52 38 Q57 55 44 63',
911→        'bodyGradient',
912→        { stroke: 'bodyDark', strokeWidth: 0.7 },
913→      ),
914→      l.circle('head', 57, 35, 7, 'bodyGradient', {
915→        stroke: 'bodyDark',
916→        strokeWidth: 0.7,
917→      }),
918→      l.path('beak', 'M62 33 C70 34 72 40 62 40 Z', 'accent', {
919→        stroke: 'accentDark',
920→        strokeWidth: 0.7,
921→        motion: 'pulse',
922→        origin: '62px 36px',
923→      }),
924→      l.path('wing', 'M34 58 C26 56 28 66 37 63', 'none', {
925→        stroke: 'bodyDark',
926→        strokeWidth: 2.5,
927→        motion: 'wing',
928→      }),
929→    ],
930→    eyes: {
931→      left: { cx: 55, cy: 33, rx: 1.3, ry: 1.8 },
932→      right: { cx: 55, cy: 33, rx: 1.3, ry: 1.8 },
933→      highlight: true,
934→    },
935→    mouth: {
936→      idle: 'M63 39 Q66 40 68 39',
937→      speaking: 'M63 39 Q67 43 70 39',
938→      stroke: 'accentDark',
939→      strokeWidth: 1,
940→    },
941→  },
942→  dragon: {
943→    name: 'Dragon',
944→    palette: palettes.dragon,
945→    layers: [
946→      l.path('left-wing', 'M32 48 L14 36 L24 57 Z', 'bodyDark', {
947→        motion: 'wing',
948→        origin: '32px 48px',
949→      }),
950→      l.path('right-wing', 'M68 48 L86 36 L76 57 Z', 'bodyDark', {
951→        motion: 'wing',
952→        origin: '68px 48px',
953→        delay: 0.12,
954→      }),
955→      l.path(
956→        'body',
957→        'M50 27 C32 27 26 61 26 72 C26 83 74 83 74 72 C74 61 68 27 50 27 Z',
958→        'bodyGradient',
959→        { stroke: 'line', strokeWidth: 1.3 },
960→      ),
961→      l.ellipse('belly', 50, 63, 15, 12, 'belly', { opacity: 0.9 }),
962→      l.polygon('left-horn', '36 31 26 18 40 27', 'accent'),
963→      l.polygon('right-horn', '64 31 74 18 60 27', 'accent'),
964→      l.ellipse('snout', 50, 47, 6, 3.5, 'bodyDark', { opacity: 0.55 }),
965→      l.line('belly-line-1', 42, 61, 58, 61, 'accentDark', {
966→        strokeWidth: 1,
967→        opacity: 0.55,
968→      }),
969→      l.line('belly-line-2', 43, 66, 57, 66, 'accentDark', {
970→        strokeWidth: 1,
971→        opacity: 0.45,
972→      }),
973→    ],
974→    eyes: {
975→      left: { cx: 41, cy: 42, rx: 4, ry: 2.4 },
976→      right: { cx: 59, cy: 42, rx: 4, ry: 2.4 },
977→      fill: 'face',
978→    },
979→    mouth: {
980→      idle: 'M47 52 Q50 54 53 52',
981→      speaking: 'M44 52 Q50 59 56 52',
982→      stroke: 'line',
983→      strokeWidth: 2,
984→    },
985→  },
986→  octopus: {
987→    name: 'Octopus',
988→    palette: palettes.octopus,
989→    layers: [
990→      l.path('tentacle-1', 'M32 61 C24 66 20 74 24 79', 'none', {
991→        stroke: 'bodyDark',
992→        strokeWidth: 5.5,
993→        motion: 'tentacle',
994→        origin: '50px 62px',
995→      }),
996→      l.path('tentacle-2', 'M41 64 C36 71 35 78 41 82', 'none', {
997→        stroke: 'body',
998→        strokeWidth: 5.5,
999→        motion: 'tentacle',
1000→        origin: '50px 62px',