#!/bin/bash
cd /root/.openclaw/workspace/crypto

# 直接用jq读json，比启动Python快很多
ARB=$(cat arbitrage_state.json)
PNL=$(echo "$ARB" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'{d[\"totalPnl\"]:.2f}|{d.get(\"fundingPnl\",0):.2f}|{d.get(\"crossArbPnl\",0):.2f}|{d[\"trades\"]}|{sum(d.get(\"balance\",{}).values()):.0f}')")
POSITIONS=$(echo "$ARB" | python3 -c "
import sys,json;d=json.load(sys.stdin)
for p in d.get('fundingPositions',[]):
    print(f'{p[\"symbol\"]} (+\${p.get(\"earned\",0):.2f})')
")
BALANCES=$(echo "$ARB" | python3 -c "
import sys,json;d=json.load(sys.stdin)
b=d.get('balance',{})
print(' | '.join(f'{k} \${v:,.0f}' for k,v in sorted(b.items())))
")

# 聪明钱计数
SM=$(python3 -c "
import json
r=json.load(open('smart_money_rank.json'))
for c in ['solana','bsc','base']:
    w=r.get(c,[])
    core=len([x for x in w if x.get('weight',0)==3])
    normal=len([x for x in w if x.get('weight',0)==2])
    print(f'{c}:{core}:{normal}')
")

# 进程+内存
MEM=$(free -m | awk '/Mem/{printf "%.1f/%.1f", $3/1024, $2/1024}')

echo "$PNL"
echo "$POSITIONS"
echo "$BALANCES"
echo "$SM"
echo "MEM:${MEM}GB"
