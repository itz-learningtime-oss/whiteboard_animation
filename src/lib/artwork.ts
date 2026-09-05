import type { Scene, StudioSettings, Visual } from './project';

export type ArtStroke = { d: string; layer: 'outline' | 'detail' | 'hatch'; color?: string; width?: number };
const ink = '#343c32';
const escapeXml = (value: string) => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));

export function getArt(visual: Visual): ArtStroke[] {
  const strokes: ArtStroke[] = [];
  const p = (d: string, layer: ArtStroke['layer'] = 'outline', color?: string, width?: number) => strokes.push({ d, layer, color, width });
  const hatch = (polygon: [number, number][], spacing = 7) => {
    const angle = -.65, cos = Math.cos(angle), sin = Math.sin(angle);
    const points = polygon.map(([x,y]) => [x*cos+y*sin, -x*sin+y*cos]);
    const minY = Math.min(...points.map(point=>point[1])), maxY = Math.max(...points.map(point=>point[1]));
    for (let y=minY+spacing/2; y<maxY; y+=spacing) {
      const hits: number[] = [];
      points.forEach((a,i)=>{const b=points[(i+1)%points.length];if((a[1]<=y&&b[1]>y)||(b[1]<=y&&a[1]>y))hits.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));});
      hits.sort((a,b)=>a-b);
      for(let i=0;i+1<hits.length;i+=2) {
        const x1=hits[i],x2=hits[i+1];
        p(`M${x1*cos-y*sin} ${x1*sin+y*cos} L${x2*cos-y*sin} ${x2*sin+y*cos}`,'hatch','accent',1.25);
      }
    }
  };
  const cloud = (x: number, y: number, s = 1) => {
    p(`M${x} ${y} c${-25*s} ${-1*s} ${-28*s} ${-31*s} ${-6*s} ${-36*s} c${2*s} ${-31*s} ${43*s} ${-38*s} ${57*s} ${-13*s} c${22*s} ${-12*s} ${42*s} ${3*s} ${40*s} ${23*s} c${27*s} ${-1*s} ${32*s} ${30*s} ${8*s} ${30*s} Z`);
    p(`M${x+10*s} ${y-31*s} q${8*s} ${-12*s} ${20*s} ${-7*s}`, 'detail');
  };
  const sun = (x: number, y: number, r = 28) => {
    p(`M${x-r} ${y} a${r} ${r} 0 1 0 ${r*2} 0 a${r} ${r} 0 1 0 ${-r*2} 0`);
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      p(`M${x+Math.cos(a)*(r+9)} ${y+Math.sin(a)*(r+9)} L${x+Math.cos(a)*(r+18)} ${y+Math.sin(a)*(r+18)}`, 'detail');
    }
    for (let i = -r + 7; i < r - 6; i += 7) {
      const h = Math.sqrt(r*r-i*i) - 3;
      p(`M${x+i} ${y-h} L${x+i} ${y+h}`, 'hatch', '#c3a85b', 1.3);
    }
  };
  const tree = (x: number, y: number, s = 1) => {
    p(`M${x-4*s} ${y} l${2*s} ${-50*s} M${x+4*s} ${y} l${-2*s} ${-50*s} M${x} ${y-36*s} l${-13*s} ${-16*s} M${x+1*s} ${y-43*s} l${13*s} ${-14*s}`);
    p(`M${x-12*s} ${y-41*s} c${-23*s} ${7*s} ${-34*s} ${-19*s} ${-20*s} ${-32*s} c${-8*s} ${-24*s} ${14*s} ${-40*s} ${31*s} ${-27*s} c${25*s} ${-17*s} ${44*s} ${6*s} ${35*s} ${24*s} c${20*s} ${17*s} ${-1*s} ${43*s} ${-21*s} ${32*s}`);
    p(`M${x-23*s} ${y-73*s} q${-1*s} ${-12*s} ${10*s} ${-12*s} M${x+20*s} ${y-80*s} q${9*s} ${5*s} ${5*s} ${14*s}`, 'detail');
  };
  const crop = (x: number, y: number, s = 1) => {
    p(`M${x} ${y} q${-2*s} ${-14*s} 0 ${-29*s} M${x} ${y-13*s} q${-16*s} ${-1*s} ${-15*s} ${-15*s} q${15*s} ${1*s} ${15*s} ${15*s} M${x} ${y-20*s} q${14*s} ${1*s} ${15*s} ${-14*s} q${-14*s} ${1*s} ${-15*s} ${14*s}`, 'detail');
  };
  const house = (x: number, y: number, s = 1) => {
    p(`M${x} ${y} v${-82*s} l${60*s} ${-44*s} l${76*s} ${43*s} v${83*s} Z M${x-10*s} ${y-82*s} l${70*s} ${-54*s} l${89*s} ${49*s} l${-14*s} ${8*s} M${x+60*s} ${y-126*s} l${1*s} ${125*s}`);
    p(`M${x+13*s} ${y-9*s} v${-42*s} h${31*s} v${42*s} M${x+80*s} ${y-60*s} h${31*s} v${27*s} h${-31*s} Z M${x+95*s} ${y-60*s} v${27*s} M${x+80*s} ${y-46*s} h${31*s}`, 'detail');
    for (let i = 0; i < 8; i++) p(`M${x+68*s+i*8*s} ${y-115*s+i*4.3*s} l${-6*s} ${12*s}`, 'detail', undefined, 1);
    for (let i = 0; i < 4; i++) p(`M${x+5*s} ${y-66*s+i*15*s} h${48*s}`, 'detail', undefined, .9);
  };
  const field = () => {
    p('M209 328 Q333 274 430 295 L646 367 Q530 384 394 438 Z');
    p('M211 333 Q331 283 429 303 M221 341 Q341 292 449 309 M235 350 Q354 302 468 315 M250 360 Q369 313 490 323 M267 370 Q384 326 512 331 M281 379 Q399 336 535 339 M297 389 Q416 347 558 347 M313 399 Q434 359 581 355 M329 409 Q452 372 603 363 M346 419 Q469 387 623 370', 'detail');
    hatch([[215,329],[290,301],[357,291],[429,298],[636,366],[529,394],[395,433]],7);
    for (let i = 0; i < 6; i++) crop(278+i*38, 341-i*2.6, .45);
  };

  if (visual === 'rainwater' || visual === 'growth') {
    p('M112 330 Q168 299 217 314 Q286 258 359 292 M469 294 Q547 274 609 305 Q683 278 779 324 M105 335 Q144 330 165 338 M719 338 Q768 325 805 337', 'detail');
    house(563, 327, .85);
    tree(730, 339, .82); tree(682, 327, .52);
    field();
    p('M172 352 C140 359 146 382 185 389 C215 400 266 401 278 389 C287 378 243 367 225 359 C205 351 190 348 172 352 Z');
    for (let i = 0; i < 6; i++) p(`M${166+i*3} ${361+i*5} q38 -1 ${65+i*5} 9`, 'hatch', '#83a1a1', 1.4);
    p('M484 296 l0 -32 M506 300 v-31 M531 307 v-30 M551 313 v-30 M480 275 l76 21 M481 285 l74 22', 'detail');
    p('M450 327 q31 -4 46 10 M491 328 l6 10 l-13 1', 'detail');
    p('M617 333 q10 6 4 16 q-8 8 -3 16 M608 360 l10 7 l10 -9', 'detail');
    if (visual === 'rainwater') {
      cloud(260, 176, 1.08); cloud(173, 212, .64); sun(673, 177, 25);
      for (let i = 0; i < 9; i++) {
        const x = 249+(i%5)*25, y=196+Math.floor(i/5)*30;
        p(`M${x} ${y} l-6 14`, 'detail', '#829a9c', 1.8);
      }
      p('M206 252 C179 268 170 297 180 316 M170 309 l11 10 l8 -14', 'detail');
    } else {
      sun(352, 182, 32); cloud(575, 187, .65);
      for (let i = 0; i < 5; i++) crop(302+i*52, 364+i*8, .8);
      p('M184 236 q12 -12 25 0 q12 -12 24 0 M484 197 q10 -9 20 0 q10 -9 20 0', 'detail');
    }
  } else if (visual === 'collection' || visual === 'storage') {
    cloud(344, 178, 1.3); cloud(201, 205, .64);
    house(252, 389, 1.25);
    p('M241 284 L329 215 L438 277 L439 289 L330 229 L250 295 Z', 'detail');
    p('M432 281 h52 v66 h57 M443 292 h29 v67 h69');
    p('M542 338 C548 326 641 326 650 338 L650 408 C636 422 553 422 542 408 Z M542 338 C552 354 639 354 650 338');
    p('M543 365 Q594 377 649 365 M543 390 Q594 403 649 390 M559 352 v50 M631 352 v50', 'detail');
    p('M651 383 h22 v17 h-11 v-9 h-11 M672 401 v8', 'detail');
    p('M519 420 q72 10 151 0 M225 397 q23 -4 40 0 M216 406 h23 M448 412 h59', 'detail');
    for (let i=0; i<9; i++) p(`M${551+i*11} 370 v${33-Math.abs(i-4)*1.4}`, 'hatch', 'accent', 1.5);
    for (let i=0; i<12; i++) p(`M${259+(i%6)*30} ${194+Math.floor(i/6)*28} l-5 13`, 'detail', '#839da1', 1.7);
    p('M696 270 C738 298 734 338 700 356 M704 344 l-5 14 l16 -2', 'detail');
    tree(748, 414, .78); crop(194, 408, .9);
    if (visual === 'storage') {
      p('M587 363 C574 380 568 388 577 396 C587 405 602 397 599 387 Z', 'detail');
      p('M456 233 l14 2 l-7 13 M470 235 q43 8 45 46', 'detail');
    }
  } else if (visual === 'sun') {
    sun(339, 200, 55); cloud(607, 202, .72);
    p('M232 315 L483 315 L524 402 L190 402 Z M278 315 l-18 87 M328 315 l-6 87 M379 315 l9 87 M431 315 l20 87 M216 344 h281 M203 373 h308 M227 403 v20 M490 403 v20');
    for (let i=0; i<20; i++) p(`M${241+i*11} 322 l-19 72`, 'hatch', 'accent', 1.4);
    house(610, 393, .9);
    p('M526 367 C559 360 548 338 578 335 M566 327 l13 7 l-10 10 M334 275 v23 M323 288 l11 13 l10 -13', 'detail');
    p('M165 423 Q343 429 541 424 M585 407 q97 14 170 0', 'detail');
  } else if (visual === 'truck') {
    p('M236 229 H493 V366 H235 Z M493 274 H563 L616 326 V366 H493 M508 289 H552 L585 325 H508 Z M616 344 H632 V368 H613 M223 366 H254 M295 366 H515 M563 367 H613');
    p('M252 369 a28 28 0 1 0 56 0 a28 28 0 1 0 -56 0 M519 369 a28 28 0 1 0 56 0 a28 28 0 1 0 -56 0 M267 369 a13 13 0 1 0 26 0 a13 13 0 1 0 -26 0 M534 369 a13 13 0 1 0 26 0 a13 13 0 1 0 -26 0');
    p('M265 259 H457 M265 275 H457 M265 291 H408 M504 336 h15 M246 345 h235 M180 310 h36 M157 330 h59 M172 350 h44 M175 410 H670', 'detail');
    for (let i=0;i<18;i++) p(`M${255+i*12} 312 l-10 23`, 'hatch', 'accent', 1.8);
    tree(731, 387, 1); cloud(263, 173, .65);
    p('M401 183 Q462 159 505 205 M490 201 l16 6 l-1 -18', 'detail');
  } else if (visual === 'leaf') {
    p('M445 416 C438 358 454 314 447 269 C444 240 451 218 458 198 M449 318 C387 327 330 280 328 232 C390 230 442 264 449 318 Z M452 278 C497 284 563 244 565 187 C505 189 460 219 452 278 Z M444 373 C383 381 315 350 302 299 C371 293 425 326 444 373 Z M446 358 C502 365 575 330 589 283 C527 275 462 315 446 358 Z');
    p('M333 238 L443 313 M559 194 L458 272 M309 305 L439 368 M582 290 L452 354 M426 424 C393 430 366 425 341 432 M452 423 q68 -8 115 10 M451 426 l-16 27 M451 426 l12 30 M443 439 l-27 8 M459 442 l23 8', 'detail');
    for (let i=0; i<12; i++) p(`M${462+i*7} ${268-i*6} l${5+i*.8} ${-15-i}`, 'hatch', 'accent', 1.4);
    sun(673, 218, 27); cloud(224, 229, .7);
    p('M267 272 C281 290 281 298 270 301 C256 304 254 292 267 272 Z M670 282 q-21 30 -49 31 M627 302 l-8 12 l16 3', 'detail');
  } else {
    p('M448 246 C394 213 320 213 267 226 L267 389 C321 374 395 378 448 408 C502 378 575 374 633 389 L633 226 C574 213 504 213 448 246 Z M448 247 V407 M256 242 H242 V407 C312 390 383 405 448 429 C518 405 590 390 659 407 V241 H643');
    for (let i=0;i<6;i++) {
      p(`M289 ${252+i*21} Q360 ${236+i*21} 423 ${269+i*21}`, 'detail');
      p(`M476 ${269+i*21} Q549 ${236+i*21} 608 ${252+i*21}`, 'detail');
    }
    for (let i=0;i<12;i++) p(`M${291+i*10} ${370+i*.9} l-2 8 M${484+i*10} ${379-i*.9} l2 8`, 'hatch', 'accent', 1.5);
    p('M434 182 q0 -18 18 -18 q20 0 20 18 q0 12 -12 18 v13 h-17 v-13 q-9 -8 -9 -18 M443 219 h18 M452 146 v-11 M484 158 l10 -8 M420 158 l-10 -8', 'detail');
    p('M195 333 l14 0 M202 326 v14 M700 264 h15 M707 257 v15', 'detail');
  }
  return strokes.sort((a,b) => ['outline','detail','hatch'].indexOf(a.layer) - ['outline','detail','hatch'].indexOf(b.layer));
}

export function artworkMarkup(visual: Visual, settings: Pick<StudioSettings, 'color' | 'hatching'>) {
  return getArt(visual).filter(p => settings.hatching || p.layer !== 'hatch').map(s =>
    `<path class="art-stroke" data-layer="${s.layer}"${s.color === 'accent' ? ' data-accent="true"' : ''} d="${s.d}" fill="none" stroke="${s.color === 'accent' ? settings.color : s.color || ink}" stroke-width="${s.width || (s.layer === 'outline' ? 2.2 : 1.45)}" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join('');
}

export function boardMarkup(scene: Scene, settings: StudioSettings, thumbnail = false) {
  const heading = escapeXml(scene.title.length > 55 ? `${scene.title.slice(0,52)}...` : scene.title);
  const artTransform = scene.layout === 'illustration_left' ? 'translate(-73 17) scale(.85)' : 'translate(0 0)';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 506" fill="none" aria-label="${heading}">
    <rect width="900" height="506" fill="${settings.paper}"/>
    <text x="450" y="85" text-anchor="middle" fill="${ink}" font-family="Caveat, Noto Sans Devanagari, cursive" font-size="${scene.title.length > 35 ? 34 : 43}" font-weight="600">${heading}</text>
    <path d="M343 98 Q450 92 557 97" stroke="${settings.color}" stroke-width="2.2" stroke-linecap="round"/>
    <g class="illustration-art" transform="${artTransform}">${artworkMarkup(scene.visual, settings)}</g>
    ${!thumbnail ? `<text x="450" y="478" text-anchor="middle" fill="#777e6f" font-family="Caveat, cursive" font-size="20">${scene.visual === 'rainwater' ? 'A simple idea. A sustainable future.' : scene.visual === 'growth' ? 'Small steps. A greener world.' : 'A little curiosity goes a long way.'}</text>` : ''}
  </svg>`;
}

export const boardInk = ink;