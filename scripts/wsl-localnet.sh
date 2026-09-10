#!/usr/bin/env bash
# Локальний валідатор із обома програмами вже в генезисі.
#
# Кликати з PowerShell, не з Git Bash (той переписує /mnt-шлях):
#   wsl.exe -e bash /mnt/<диск>/<шлях до репо>/scripts/wsl-localnet.sh <start|stop|status|run|reset>
#
#   start   — свіжий реєстр, валідатор у фоні, чекає, доки вузол відповість
#   stop    — зупинити фоновий валідатор
#   status  — чи відповідає вузол, і які програми в ньому
#   run     — те саме, що start, але в передньому плані (окремий термінал)
#   reset   — stop + прибрати реєстр
#
# `--bpf-program` кладе програму в генезис: деплою немає, SOL не витрачається,
# адреса та сама, що в `declare_id!`. Тому цикл T025 налагоджується тут, а на
# devnet (T032) іде вже готовим — один раз і за гроші. Реєстр щоразу свіжий:
# програма з генезису не оновлюється в наявному реєстрі, і після перезбірки
# `.so` старий реєстр мовчки виконував би старий байткод.
#
# Без `--bind-address 0.0.0.0`: Agave 3.1 на ньому панікує (`UnspecifiedIpAddr`),
# а WSL2 і так пробрасує 127.0.0.1:8899 у Windows.

set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD="${1:-start}"
SO="$ROOT/target/deploy/caprail.so"
HOOK_SO="$ROOT/target/deploy/caprail_hook.so"
# Ті самі ключі, що в wsl-build.sh: адреса програми в генезисі береться з
# ключа, і збіг із declare_id! перевіряється нижче, а не першою транзакцією.
KEYS="${CAPRAIL_PROGRAM_KEYPAIR:-$HOME/.config/caprail/caprail-keypair.json}"
HOOK_KEYS="${CAPRAIL_HOOK_PROGRAM_KEYPAIR:-$HOME/.config/caprail/caprail-hook-keypair.json}"
CAPRAIL_ID="As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g"
HOOK_ID="6EMZVfUkf2wrtwfnESLghWfdWyzDu71uJTJ7dCKG3YEi"

# Реєстр — у файловій системі WSL, не в /mnt: на 9p валідатор пише його в рази
# повільніше і час від часу ламає на зупинці.
# pid і лог — поруч, а не всередині: `--reset` вичищає теку реєстру разом з усім,
# що в ній лежить.
STATE="$HOME/.cache/caprail-localnet"
LEDGER="$STATE/ledger"
LOG="$STATE/validator.log"
PID_FILE="$STATE/validator.pid"
RPC="http://127.0.0.1:8899"

rpc() {
  curl -s -m 2 "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}"
}

healthy() {
  [[ "$(rpc getHealth)" == *'"ok"'* ]]
}

running_pid() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    cat "$PID_FILE"
  fi
}

# Артефакт у генезисі має бути тим, що йде в мережу: після `wsl-build.sh idl`
# у target/deploy лежить v3, який Agave не виконує, — «Program is not deployed»
# на першій же інструкції, без натяку на причину.
check_artifacts() {
  local so flags
  for so in "$SO" "$HOOK_SO"; do
    if [[ ! -f "$so" ]]; then
      echo "немає $so — спершу: scripts/wsl-build.sh build-sbf" >&2
      exit 1
    fi
    flags="$(readelf -h "$so" | awk '/Flags:/ {print $2}')"
    if [[ "$flags" != "0x0" ]]; then
      echo "ПОМИЛКА: $so має e_flags=$flags (не SBPFv0) — спершу: scripts/wsl-build.sh build-sbf" >&2
      exit 1
    fi
  done
  for key in "$KEYS" "$HOOK_KEYS"; do
    if [[ ! -f "$key" ]]; then
      echo "немає ключа програми $key" >&2
      exit 1
    fi
  done
  local caprail hook
  caprail="$(solana address -k "$KEYS")"
  hook="$(solana address -k "$HOOK_KEYS")"
  if [[ "$caprail" != "$CAPRAIL_ID" || "$hook" != "$HOOK_ID" ]]; then
    echo "ПОМИЛКА: ключі програм не збігаються з declare_id!: $caprail / $hook" >&2
    exit 1
  fi
}

wait_healthy() {
  local i
  for i in $(seq 1 60); do
    if healthy; then
      return 0
    fi
    sleep 1
  done
  echo "валідатор не відповів за 60 с — останні рядки $LOG:" >&2
  tail -20 "$LOG" >&2
  exit 1
}

validator_args() {
  echo --reset --ledger "$LEDGER" \
    --bpf-program "$CAPRAIL_ID" "$SO" \
    --bpf-program "$HOOK_ID" "$HOOK_SO"
}

do_stop() {
  local pid
  pid="$(running_pid || true)"
  if [[ -n "$pid" ]]; then
    kill "$pid"
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    echo "зупинено (pid $pid)"
  else
    echo "фоновий валідатор не запущений"
  fi
  rm -f "$PID_FILE"
}

case "$CMD" in
  start)
    if [[ -n "$(running_pid || true)" ]]; then
      echo "уже запущений (pid $(cat "$PID_FILE")); спершу: $0 stop" >&2
      exit 1
    fi
    if healthy; then
      echo "на $RPC уже хтось відповідає — не цей скрипт; зупиніть його руками" >&2
      exit 1
    fi
    check_artifacts
    mkdir -p "$STATE"
    # shellcheck disable=SC2046
    nohup solana-test-validator $(validator_args) >"$LOG" 2>&1 &
    echo $! >"$PID_FILE"
    wait_healthy
    echo "OK — валідатор на $RPC (pid $(cat "$PID_FILE"))"
    echo "caprail      = $CAPRAIL_ID"
    echo "caprail-hook = $HOOK_ID"
    echo "лог: $LOG"
    ;;
  run)
    check_artifacts
    mkdir -p "$STATE"
    # shellcheck disable=SC2046
    exec solana-test-validator $(validator_args)
    ;;
  stop)
    do_stop
    ;;
  status)
    if healthy; then
      echo "вузол: ok ($RPC), слот $(rpc getSlot | sed -E 's/.*"result":([0-9]+).*/\1/')"
      for id in "$CAPRAIL_ID" "$HOOK_ID"; do
        if [[ "$(rpc getAccountInfo "[\"$id\"]")" == *'"executable":true'* ]]; then
          echo "програма $id: є"
        else
          echo "програма $id: НЕМАЄ"
        fi
      done
      pid="$(running_pid || true)"
      if [[ -n "$pid" ]]; then
        echo "фоновий pid: $pid"
      fi
    else
      echo "вузол не відповідає на $RPC"
      exit 1
    fi
    ;;
  reset)
    do_stop
    rm -rf "$STATE"
    echo "реєстр прибрано"
    ;;
  *)
    echo "невідома команда: $CMD (start | stop | status | run | reset)" >&2
    exit 2
    ;;
esac
