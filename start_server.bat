@echo off
echo Starting local server at http://localhost:8080 ...
start "" "http://localhost:8080"
python -m http.server 8080
pause
