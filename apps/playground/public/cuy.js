// Aule's face: a cuy with round glasses, as on Aule's icon, for the wobnimo
// mascot the page already runs. A character is plain data: the engine makes
// it breathe, blink, talk and act out what the tutor is doing. Checked and
// drawn with `npx wobnimo check` and `npx wobnimo preview`.
//
// Units: the floor is y = 0, +y is up, +x is to the right as you look at the
// cuy, +z points at the camera. Angles are radians.

export const cuy = {
  id: "cuy",
  name: "Cuy",
  tagline: "A ginger cuy with a white blaze and round glasses",
  accent: "#9a5b2e",
  frame: { target: 0.3, radius: 0.5 },
  bound: { y: 0.3, radius: 0.55 },
  // A soft loaf: it squashes when it lands and bounces as it talks.
  motion: { hop: 0.14, squash: 1.5, snap: 1, talkSquash: 0.7 },

  materials: {
    fur: { color: "#d9842f", f0: 0.015, spec: 0.06, shininess: 6, rim: 0.35, sheen: 0.3, gloss: 0, sss: 0.15, sssColor: "#f5c79a" },
    pink: { color: "#e8929a", f0: 0.03, spec: 0.2, shininess: 20, rim: 0.3, sss: 0.3, sssColor: "#ffd3d8" },
    nose: { color: "#d9737a", f0: 0.06, spec: 1.2, shininess: 120, rim: 0.3, gloss: 0.7 },
    rims: { color: "#2e1d24", f0: 0.06, spec: 1.6, shininess: 160, rim: 0.4, gloss: 0.8 },
  },

  // A cuy is one loaf, head and body together; its ears spring.
  bones: [
    { name: "body", pivot: [0, 0, 0], drive: { rx: [["pitch", -0.3]], ry: [["yaw", 0.35]], rz: [["roll", 0.4]] } },
    { name: "earL", parent: "body", pivot: [-0.27, 0.4, 0], rest: { rz: 1.0 }, jiggle: { axis: [0, 1, 0], length: 0.1, freq: 3, damping: 0.2, maxAngle: 0.5 } },
    { name: "earR", parent: "body", pivot: [0.27, 0.4, 0], rest: { rz: -1.0 }, jiggle: { axis: [0, 1, 0], length: 0.1, freq: 3, damping: 0.2, maxAngle: 0.5 } },
  ],

  parts: [
    // The loaf, 0.52 tall and 0.68 wide, and fuller cheeks low at the front.
    { bone: "body", shape: "ellipsoid", at: [0, 0.26, 0], radii: [0.34, 0.26, 0.28], material: "fur" },
    { bone: "body", shape: "ellipsoid", at: [0, 0.19, 0.1], radii: [0.3, 0.18, 0.24], blend: 0.1, material: "fur" },
    // Two small feet under it.
    { bone: "body", shape: "ellipsoid", at: [-0.14, 0.035, 0.24], radii: [0.07, 0.035, 0.08], blend: 0.02, material: "pink" },
    { bone: "body", shape: "ellipsoid", at: [0.14, 0.035, 0.24], radii: [0.07, 0.035, 0.08], blend: 0.02, material: "pink" },
    { bone: "body", shape: "ellipsoid", at: [0, 0.255, 0.335], radii: [0.035, 0.024, 0.02], material: "nose" },
    // Petal ears that hang out to the sides.
    { bone: "earL", shape: "ellipsoid", at: [0, 0.06, 0], radii: [0.07, 0.09, 0.03], material: "pink" },
    { bone: "earR", shape: "ellipsoid", at: [0, 0.06, 0], radii: [0.07, 0.09, 0.03], material: "pink" },
    // The glasses: a ring before each eye and the bridge between them.
    { bone: "body", shape: "frame", at: [-0.125, 0.33, 0.29], half: [0.082, 0.082], corner: 0.082, width: 0.013, depth: 0.01, material: "rims" },
    { bone: "body", shape: "frame", at: [0.125, 0.33, 0.29], half: [0.082, 0.082], corner: 0.082, width: 0.013, depth: 0.01, material: "rims" },
    { bone: "body", shape: "capsule", from: [-0.045, 0.335, 0.3], to: [0.045, 0.335, 0.3], radius: 0.011, material: "rims" },
  ],

  paints: [
    // The white blaze: over the muzzle and cheeks, and up between the eyes.
    { bone: "body", on: ["fur"], kind: "ellipse", at: [0, 0.2, 0.15], radii: [0.2, 0.15], color: "#f6f0e4", soft: 0.2 },
    { bone: "body", on: ["fur"], kind: "ellipse", at: [0, 0.4, 0.1], radii: [0.07, 0.14], color: "#f6f0e4", soft: 0.25 },
    { bone: "body", on: ["fur"], kind: "sphere", at: [-0.2, 0.22, 0.28], radius: 0.05, color: "#ff9f9f", soft: 0.6, opacity: 0.7 },
    { bone: "body", on: ["fur"], kind: "sphere", at: [0.2, 0.22, 0.28], radius: 0.05, color: "#ff9f9f", soft: 0.6, opacity: 0.7 },
  ],

  eyes: { kind: "ball", bone: "body", at: [[-0.125, 0.33, 0.24], [0.125, 0.33, 0.24]], radius: 0.058, iris: "#2a1a14", irisSize: 0.86, pupilSize: 0.55, lid: "fur" },
  face: { kind: "mouth", bone: "body", on: ["fur"], at: [0, 0.19, 0.34], width: 0.07, color: "#3a1512", tongue: "#ff8fa3" },

  anchors: {
    top: { bone: "body", at: [0.15, 0.58, 0.05] },
    mouth: { bone: "body", at: [0, 0.19, 0.37] },
    ear: { bone: "earL", at: [0, 0.06, 0] },
    feet: { bone: "root", at: [0, 0.02, 0.2] },
  },

  // The ears say most of it: up to listen, down when sad or asleep.
  acting: {
    thinking: { body: { rz: 0.08 }, earL: { rz: [0, 0.08, 1.2, 0] } },
    listening: { earL: { rz: -0.7 }, earR: { rz: 0.7 } },
    speaking: { earL: { rz: [0, 0.1, 2.2, 0] }, earR: { rz: [0, 0.1, 2.2, 1.5] } },
    sleeping: { earL: { rz: 0.35, rx: 0.3 }, earR: { rz: -0.35, rx: 0.3 }, body: { rx: 0.08 } },
    sad: { earL: { rz: 0.45, rx: 0.4 }, earR: { rz: -0.45, rx: 0.4 } },
    surprised: { earL: { rz: -0.85 }, earR: { rz: 0.85 } },
    celebrating: { earL: { rz: [-0.2, 0.3, 5, 0] }, earR: { rz: [0.2, 0.3, 5, 3.14] } },
    error: { earL: { rz: [0.2, 0.15, 10, 0] }, earR: { rz: [-0.2, 0.15, 10, 1] } },
    happy: { earL: { rz: [-0.3, 0.25, 4, 0] }, earR: { rz: [0.3, 0.25, 4, 2] } },
  },
};

export default cuy;
