#!/bin/bash
# Start / stop / restart the web dashboard in the background.   ./dashboard.sh [start|stop|status]
cd "$(dirname "$0")" && mkdir -p logs
pid=$(cat logs/dashboard.pid 2>/dev/null)
case "${1:-start}" in
  stop|start)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null && sleep 2
    [ "$1" = stop ] && exit 0
    setsid nohup .venv/bin/python -u dashboard.py > logs/dashboard.log 2>&1 < /dev/null &
    echo $! > logs/dashboard.pid
    sleep 3; cat logs/dashboard.log ;;
  status) [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "running (pid $pid)" || echo "not running" ;;
esac
