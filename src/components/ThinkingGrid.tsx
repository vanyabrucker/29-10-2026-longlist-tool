"use client";

import { motion } from "motion/react";

// The logo square split into a 3x3 grid. Corners, edges and center fade as
// three groups, cycling hollow -> corners -> X -> dot -> plus -> full -> hollow.
// Measured in equal steps: corners, X, dot and plus each hold one step, the
// hollow square holds half a step, the full square doesn't hold, and each of
// the six fades between shapes takes one step (10.5 steps per cycle).
const DIM = 0.12;
const STEPS = 10.5;
const step = (n: number) => n / STEPS;
const GRID_PHASES = {
  // On through X, fade out to dot, back in after plus.
  corner: {
    times: [0, 4.5, 5.5, 8.5, 9.5, STEPS].map(step),
    opacity: [1, 1, DIM, DIM, 1, 1],
  },
  // Fade out after hollow, back in after dot.
  edge: {
    times: [0, 0.5, 1.5, 6.5, 7.5, STEPS].map(step),
    opacity: [1, 1, DIM, DIM, 1, 1],
  },
  // Fade in after corners, out again after the full square.
  center: {
    times: [0, 2.5, 3.5, 9.5, STEPS].map(step),
    opacity: [DIM, DIM, 1, 1, DIM],
  },
};

export function ThinkingGrid() {
  return (
    <div className="flex h-[25px] items-center" aria-label="Thinking">
      <div className="grid grid-cols-3">
        {Array.from({ length: 9 }, (_, i) => {
          const group = i === 4 ? "center" : i % 2 === 0 ? "corner" : "edge";
          const { times, opacity } = GRID_PHASES[group];
          return (
            <motion.span
              key={i}
              className="size-[6px] bg-brand"
              initial={{ opacity: opacity[0] }}
              animate={{ opacity }}
              transition={{
                duration: 0.62, // ~59ms per step
                times,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
