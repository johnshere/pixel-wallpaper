'use strict'

/**
 * 六支算法的参数 schema —— 由 scripts/build.mjs 从 client/index.js 生成，勿手改。
 * 服务端 sanitize 与设置页共用同一份定义：新增/调整二级参数只改客户端注册表。
 */

module.exports = {
  "boids": [
    {
      "key": "agents",
      "label": "智能体数量",
      "type": "range",
      "min": 60,
      "max": 200,
      "step": 10,
      "default": 80
    },
    {
      "key": "separation",
      "label": "分离权重",
      "type": "range",
      "min": 0,
      "max": 4,
      "step": 0.1,
      "default": 1.6
    },
    {
      "key": "alignment",
      "label": "对齐权重",
      "type": "range",
      "min": 0,
      "max": 2,
      "step": 0.05,
      "default": 0.9
    },
    {
      "key": "cohesion",
      "label": "聚合权重",
      "type": "range",
      "min": 0,
      "max": 3,
      "step": 0.1,
      "default": 0.7
    },
    {
      "key": "speed",
      "label": "速度",
      "type": "range",
      "min": 0.4,
      "max": 2.4,
      "step": 0.1,
      "default": 1.2
    },
    {
      "key": "trail",
      "label": "拖尾",
      "type": "range",
      "min": 0.9,
      "max": 0.995,
      "step": 0.005,
      "default": 0.98
    }
  ],
  "flow": [
    {
      "key": "particles",
      "label": "粒子数量",
      "type": "range",
      "min": 300,
      "max": 3000,
      "step": 100,
      "default": 1200
    },
    {
      "key": "scale",
      "label": "尺度",
      "type": "range",
      "min": 0.6,
      "max": 6,
      "step": 0.1,
      "default": 1.8
    },
    {
      "key": "trail",
      "label": "拖尾",
      "type": "range",
      "min": 0.9,
      "max": 0.995,
      "step": 0.005,
      "default": 0.975
    }
  ],
  "reaction": [
    {
      "key": "feed",
      "label": "补给率",
      "type": "range",
      "min": 0.01,
      "max": 0.08,
      "step": 0.001,
      "default": 0.0367
    },
    {
      "key": "kill",
      "label": "消解率",
      "type": "range",
      "min": 0.04,
      "max": 0.07,
      "step": 0.001,
      "default": 0.0649
    },
    {
      "key": "steps",
      "label": "步数",
      "type": "range",
      "min": 1,
      "max": 12,
      "step": 1,
      "default": 4
    }
  ],
  "noise": [
    {
      "key": "scale",
      "label": "尺度",
      "type": "range",
      "min": 0.6,
      "max": 8,
      "step": 0.1,
      "default": 2.2
    },
    {
      "key": "octaves",
      "label": "八度",
      "type": "range",
      "min": 2,
      "max": 6,
      "step": 1,
      "default": 4
    },
    {
      "key": "warp",
      "label": "扭曲",
      "type": "range",
      "min": 0,
      "max": 1,
      "step": 0.05,
      "default": 0.35
    },
    {
      "key": "drift",
      "label": "漂移",
      "type": "range",
      "min": 0,
      "max": 1,
      "step": 0.05,
      "default": 0.15
    }
  ],
  "waves": [
    {
      "key": "sources",
      "label": "波源数",
      "type": "range",
      "min": 2,
      "max": 12,
      "step": 1,
      "default": 5
    },
    {
      "key": "freq",
      "label": "频率",
      "type": "range",
      "min": 0.5,
      "max": 6,
      "step": 0.1,
      "default": 2.2
    },
    {
      "key": "speed",
      "label": "速度",
      "type": "range",
      "min": 0,
      "max": 2,
      "step": 0.1,
      "default": 0.8
    },
    {
      "key": "decay",
      "label": "衰减",
      "type": "range",
      "min": 0,
      "max": 1,
      "step": 0.05,
      "default": 0.3
    }
  ],
  "attractor": [
    {
      "key": "type",
      "label": "吸引子类型",
      "type": "select",
      "options": [
        {
          "value": "Clifford",
          "label": "Clifford"
        },
        {
          "value": "De Jong",
          "label": "De Jong"
        }
      ],
      "default": "Clifford"
    },
    {
      "key": "a",
      "label": "参数 a",
      "type": "range",
      "min": -3,
      "max": 3,
      "step": 0.1,
      "default": -1.4
    },
    {
      "key": "b",
      "label": "参数 b",
      "type": "range",
      "min": -3,
      "max": 3,
      "step": 0.1,
      "default": 1.6
    },
    {
      "key": "c",
      "label": "参数 c",
      "type": "range",
      "min": -3,
      "max": 3,
      "step": 0.1,
      "default": 1
    },
    {
      "key": "d",
      "label": "参数 d",
      "type": "range",
      "min": -3,
      "max": 3,
      "step": 0.1,
      "default": 0.7
    },
    {
      "key": "points",
      "label": "点数",
      "type": "range",
      "min": 500,
      "max": 6000,
      "step": 100,
      "default": 2500
    }
  ]
}

