import type { ComponentType } from 'react';

import type { DotMatrixCommonProps } from './dotmatrix-core';

import { DotmSquare1 } from './dotm-square-1';
import { DotmSquare2 } from './dotm-square-2';
import { DotmSquare3 } from './dotm-square-3';
import { DotmSquare4 } from './dotm-square-4';
import { DotmSquare5 } from './dotm-square-5';
import { DotmSquare6 } from './dotm-square-6';
import { DotmSquare7 } from './dotm-square-7';
import { DotmSquare8 } from './dotm-square-8';
import { DotmSquare9 } from './dotm-square-9';
import { DotmSquare10 } from './dotm-square-10';
import { DotmSquare11 } from './dotm-square-11';
import { DotmSquare12 } from './dotm-square-12';
import { DotmSquare13 } from './dotm-square-13';
import { DotmSquare14 } from './dotm-square-14';
import { DotmSquare15 } from './dotm-square-15';
import { DotmSquare16 } from './dotm-square-16';
import { DotmSquare17 } from './dotm-square-17';
import { DotmSquare18 } from './dotm-square-18';
import { DotmSquare19 } from './dotm-square-19';
import { DotmSquare20 } from './dotm-square-20';
import { DotmCircular1 } from './dotm-circular-1';
import { DotmCircular2 } from './dotm-circular-2';
import { DotmCircular3 } from './dotm-circular-3';
import { DotmCircular4 } from './dotm-circular-4';
import { DotmCircular5 } from './dotm-circular-5';
import { DotmCircular6 } from './dotm-circular-6';
import { DotmCircular7 } from './dotm-circular-7';
import { DotmCircular8 } from './dotm-circular-8';
import { DotmCircular9 } from './dotm-circular-9';
import { DotmCircular10 } from './dotm-circular-10';
import { DotmCircular11 } from './dotm-circular-11';
import { DotmCircular12 } from './dotm-circular-12';
import { DotmCircular13 } from './dotm-circular-13';
import { DotmCircular14 } from './dotm-circular-14';
import { DotmCircular15 } from './dotm-circular-15';
import { DotmCircular16 } from './dotm-circular-16';
import { DotmCircular17 } from './dotm-circular-17';
import { DotmCircular18 } from './dotm-circular-18';
import { DotmCircular19 } from './dotm-circular-19';
import { DotmCircular20 } from './dotm-circular-20';
import { DotmTriangle1 } from './dotm-triangle-1';
import { DotmTriangle2 } from './dotm-triangle-2';
import { DotmTriangle3 } from './dotm-triangle-3';
import { DotmTriangle4 } from './dotm-triangle-4';
import { DotmTriangle5 } from './dotm-triangle-5';
import { DotmTriangle6 } from './dotm-triangle-6';
import { DotmTriangle7 } from './dotm-triangle-7';
import { DotmTriangle8 } from './dotm-triangle-8';
import { DotmTriangle9 } from './dotm-triangle-9';
import { DotmTriangle10 } from './dotm-triangle-10';
import { DotmTriangle11 } from './dotm-triangle-11';
import { DotmTriangle12 } from './dotm-triangle-12';
import { DotmTriangle13 } from './dotm-triangle-13';
import { DotmTriangle14 } from './dotm-triangle-14';
import { DotmTriangle15 } from './dotm-triangle-15';
import { DotmTriangle16 } from './dotm-triangle-16';
import { DotmTriangle17 } from './dotm-triangle-17';
import { DotmTriangle18 } from './dotm-triangle-18';
import { DotmTriangle19 } from './dotm-triangle-19';
import { DotmTriangle20 } from './dotm-triangle-20';

export type LoaderComponent = ComponentType<DotMatrixCommonProps>;

/**
 * Canonical, ordered list of every dot-matrix loader variant name.
 * Order is meaningful: it determines round-robin assignment in projectLoader.ts.
 */
export const LOADER_NAMES: readonly string[] = [
  'dotm-square-1',
  'dotm-square-2',
  'dotm-square-3',
  'dotm-square-4',
  'dotm-square-5',
  'dotm-square-6',
  'dotm-square-7',
  'dotm-square-8',
  'dotm-square-9',
  'dotm-square-10',
  'dotm-square-11',
  'dotm-square-12',
  'dotm-square-13',
  'dotm-square-14',
  'dotm-square-15',
  'dotm-square-16',
  'dotm-square-17',
  'dotm-square-18',
  'dotm-square-19',
  'dotm-square-20',
  'dotm-circular-1',
  'dotm-circular-2',
  'dotm-circular-3',
  'dotm-circular-4',
  'dotm-circular-5',
  'dotm-circular-6',
  'dotm-circular-7',
  'dotm-circular-8',
  'dotm-circular-9',
  'dotm-circular-10',
  'dotm-circular-11',
  'dotm-circular-12',
  'dotm-circular-13',
  'dotm-circular-14',
  'dotm-circular-15',
  'dotm-circular-16',
  'dotm-circular-17',
  'dotm-circular-18',
  'dotm-circular-19',
  'dotm-circular-20',
  'dotm-triangle-1',
  'dotm-triangle-2',
  'dotm-triangle-3',
  'dotm-triangle-4',
  'dotm-triangle-5',
  'dotm-triangle-6',
  'dotm-triangle-7',
  'dotm-triangle-8',
  'dotm-triangle-9',
  'dotm-triangle-10',
  'dotm-triangle-11',
  'dotm-triangle-12',
  'dotm-triangle-13',
  'dotm-triangle-14',
  'dotm-triangle-15',
  'dotm-triangle-16',
  'dotm-triangle-17',
  'dotm-triangle-18',
  'dotm-triangle-19',
  'dotm-triangle-20',
];

const REGISTRY = new Map<string, LoaderComponent>([
  ['dotm-square-1', DotmSquare1],
  ['dotm-square-2', DotmSquare2],
  ['dotm-square-3', DotmSquare3],
  ['dotm-square-4', DotmSquare4],
  ['dotm-square-5', DotmSquare5],
  ['dotm-square-6', DotmSquare6],
  ['dotm-square-7', DotmSquare7],
  ['dotm-square-8', DotmSquare8],
  ['dotm-square-9', DotmSquare9],
  ['dotm-square-10', DotmSquare10],
  ['dotm-square-11', DotmSquare11],
  ['dotm-square-12', DotmSquare12],
  ['dotm-square-13', DotmSquare13],
  ['dotm-square-14', DotmSquare14],
  ['dotm-square-15', DotmSquare15],
  ['dotm-square-16', DotmSquare16],
  ['dotm-square-17', DotmSquare17],
  ['dotm-square-18', DotmSquare18],
  ['dotm-square-19', DotmSquare19],
  ['dotm-square-20', DotmSquare20],
  ['dotm-circular-1', DotmCircular1],
  ['dotm-circular-2', DotmCircular2],
  ['dotm-circular-3', DotmCircular3],
  ['dotm-circular-4', DotmCircular4],
  ['dotm-circular-5', DotmCircular5],
  ['dotm-circular-6', DotmCircular6],
  ['dotm-circular-7', DotmCircular7],
  ['dotm-circular-8', DotmCircular8],
  ['dotm-circular-9', DotmCircular9],
  ['dotm-circular-10', DotmCircular10],
  ['dotm-circular-11', DotmCircular11],
  ['dotm-circular-12', DotmCircular12],
  ['dotm-circular-13', DotmCircular13],
  ['dotm-circular-14', DotmCircular14],
  ['dotm-circular-15', DotmCircular15],
  ['dotm-circular-16', DotmCircular16],
  ['dotm-circular-17', DotmCircular17],
  ['dotm-circular-18', DotmCircular18],
  ['dotm-circular-19', DotmCircular19],
  ['dotm-circular-20', DotmCircular20],
  ['dotm-triangle-1', DotmTriangle1],
  ['dotm-triangle-2', DotmTriangle2],
  ['dotm-triangle-3', DotmTriangle3],
  ['dotm-triangle-4', DotmTriangle4],
  ['dotm-triangle-5', DotmTriangle5],
  ['dotm-triangle-6', DotmTriangle6],
  ['dotm-triangle-7', DotmTriangle7],
  ['dotm-triangle-8', DotmTriangle8],
  ['dotm-triangle-9', DotmTriangle9],
  ['dotm-triangle-10', DotmTriangle10],
  ['dotm-triangle-11', DotmTriangle11],
  ['dotm-triangle-12', DotmTriangle12],
  ['dotm-triangle-13', DotmTriangle13],
  ['dotm-triangle-14', DotmTriangle14],
  ['dotm-triangle-15', DotmTriangle15],
  ['dotm-triangle-16', DotmTriangle16],
  ['dotm-triangle-17', DotmTriangle17],
  ['dotm-triangle-18', DotmTriangle18],
  ['dotm-triangle-19', DotmTriangle19],
  ['dotm-triangle-20', DotmTriangle20],
]);

export function getLoaderComponent(name: string | null | undefined): LoaderComponent {
  if (name) {
    const found = REGISTRY.get(name);
    if (found) return found;
  }
  // Fallback: first loader in the list. Should never trigger for a project that
  // was assigned a variant at creation time, but covers projects that predate
  // the loader_variant column or have a stale value.
  return REGISTRY.get(LOADER_NAMES[0])!;
}
