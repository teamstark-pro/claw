#!/bin/bash

# Kill all background processes on exit
trap "kill 0" EXIT

echo "🚀 Starting Claude Web Application..."

# Start Backend
echo "Backend: Starting FastAPI on http://localhost:8000"
(cd backend && source venv/bin/activate && uvicorn main:app --reload --port 8000) &

# Start Frontend
echo "Frontend: Starting Vite on http://localhost:5173"
(cd frontend && npm run dev) &

wait
