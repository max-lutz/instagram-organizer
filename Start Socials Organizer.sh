#!/bin/bash
cd "$(dirname "$0")"
(sleep 1 && xdg-open http://localhost:3000) &
node src/server.js
