// kpt.js — 关键点格式定义（纯数据，无浏览器依赖，Node 里也能导入做单测）

// 内部统一骨架（COCO-17 子集），顺序即 kp 数组下标
export const KPT = [
  'nose',
  'shoulder_L', 'shoulder_R',
  'elbow_L', 'elbow_R',
  'wrist_L', 'wrist_R',
  'hip_L', 'hip_R',
  'knee_L', 'knee_R',
  'ankle_L', 'ankle_R',
];

export const IDX = Object.fromEntries(KPT.map((n, i) => [n, i]));

// MediaPipe Pose 33 点中的对应下标
export const MP_INDEX = {
  nose: 0,
  shoulder_L: 11, shoulder_R: 12,
  elbow_L: 13, elbow_R: 14,
  wrist_L: 15, wrist_R: 16,
  hip_L: 23, hip_R: 24,
  knee_L: 25, knee_R: 26,
  ankle_L: 27, ankle_R: 28,
};

// 33 点之间的连线，用于绘制骨架
export const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [27, 31], [28, 30], [28, 32],
  [0, 11], [0, 12],
];

// 手部 21 点连线：腕(0) → 五指，加掌骨横连
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],          // 食指
  [5, 9], [9, 10], [10, 11], [11, 12],     // 中指
  [9, 13], [13, 14], [14, 15], [15, 16],   // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20],  // 小指
  [0, 17],
];
