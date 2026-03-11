#!/bin/bash
# 每日A股晨报生成脚本
# 由 openclaw cron 每天 7:30 触发

export PATH="/root/.nvm/versions/node/v22.22.0/bin:/root/.local/share/pnpm:$PATH"

echo "生成每日A股晨报，包含：隔夜市场数据、核心驱动因素、今日重点板块、个股推荐、风险提示、操作建议。格式参考专业晨报，数据从东方财富、新浪财经实时拉取。不分析用户个人持仓。发送给跑步哥。"
