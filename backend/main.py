import os
import json
import logging
from typing import Optional, List
from fastapi import FastAPI, HTTPException, Depends, status, Request, UploadFile, File
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from proxy_manager import _parse_proxy_url, _test_proxy
from claude_api import UserSession, validate_key, send_message_stream, DEFAULT_MODEL

load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ClaudeWeb")

app = FastAPI(title="Claude Web Proxy")

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration & State
APP_PASSWORD = os.getenv("APP_PASSWORD", "admin123")
session = UserSession()
DB_FILE = "db.json"

def load_db():
    if not os.path.exists(DB_FILE):
        return []
    try:
        with open(DB_FILE, "r") as f:
            return json.load(f)
    except:
        return []

def save_db(data):
    with open(DB_FILE, "w") as f:
        json.dump(data, f, indent=2)

def sync_pool():
    """Sync the session's account pool with verified accounts from DB."""
    db = load_db()
    verified = [acc for acc in db if acc.get('status') == 'connected']
    session.account_pool = verified
    logger.info(f"Session pool synced: {len(verified)} accounts available.")

# Initial sync
sync_pool()

# Models
class LoginRequest(BaseModel):
    password: str

class AccountEntry(BaseModel):
    email: str
    key: str
    proxy: str
    status: Optional[str] = "unknown"
    org_id: Optional[str] = ""

class ProxyAddRequest(BaseModel):
    url: str

class SettingsRequest(BaseModel):
    session_key: Optional[str] = None
    model: Optional[str] = DEFAULT_MODEL
    incognito: Optional[bool] = True
    web_search: Optional[bool] = False

class ChatRequest(BaseModel):
    message: str
    attachments: Optional[List[dict]] = []

# Dependencies
async def verify_auth(request: Request):
    # Simple token check (could be improved with JWT)
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    
    token = auth_header.split(" ")[1]
    if token != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid token")
    return token

@app.post("/api/login")
async def login(req: LoginRequest):
    if req.password == APP_PASSWORD:
        return {"token": APP_PASSWORD}
    raise HTTPException(status_code=401, detail="Invalid password")

@app.get("/api/status", dependencies=[Depends(verify_auth)])
async def get_status():
    return {
        "key_set": bool(session.session_key),
        "organization_id": session.organization_id,
        "conversation_id": session.conversation_id,
        "model": session.model,
        "incognito": session.incognito,
        "web_search": session.web_search,
        "proxy_count": session.proxy_pool.count,
        "active_proxy": session.proxy_pool.active
    }

@app.post("/api/settings", dependencies=[Depends(verify_auth)])
async def update_settings(req: SettingsRequest):
    global session
    
    # If key is provided and not empty, validate and set it
    if req.session_key and req.session_key.strip():
        # Just strip whitespace, don't over-sanitize yet as bot works without it
        clean_key = req.session_key.strip()
        
        if clean_key != session.session_key:
            # IMPORTANT: Use the active proxy for validation!
            active_proxy = session.proxy_pool.active
            logger.info(f"Validating key using proxy: {active_proxy or 'direct'}")
            valid, org_id, info = validate_key(clean_key, proxy_url=active_proxy)
            if not valid:
                raise HTTPException(status_code=400, detail=f"Invalid session key: {info}")
            session.set_key(clean_key)
            session.organization_id = org_id
    
    session.model = req.model
    session.incognito = req.incognito
    session.web_search = req.web_search
    
    return {"status": "success", "org_id": session.organization_id}

# --- Database Management Endpoints ---

@app.get("/api/db/accounts", dependencies=[Depends(verify_auth)])
async def get_accounts():
    return load_db()

@app.post("/api/db/accounts/bulk", dependencies=[Depends(verify_auth)])
async def bulk_add_accounts(accounts: List[AccountEntry]):
    db = load_db()
    for acc in accounts:
        db.append(acc.dict())
    save_db(db)
    return {"status": "success", "count": len(accounts)}

@app.delete("/api/db/accounts/{index}", dependencies=[Depends(verify_auth)])
async def delete_account(index: int):
    db = load_db()
    if 0 <= index < len(db):
        db.pop(index)
        save_db(db)
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Account not found")

@app.post("/api/db/accounts/{index}/apply", dependencies=[Depends(verify_auth)])
async def apply_account(index: int):
    global session
    db = load_db()
    if 0 <= index < len(db):
        acc = db[index]
        # Set proxy first
        session.proxy_pool.clear()
        if acc['proxy']:
            session.proxy_pool.add(acc['proxy'])
        session._sync_proxy()
        
        # Then set key
        session.set_key(acc['key'])
        
        # Validate to get org_id
        valid, org_id, info = validate_key(acc['key'], proxy_url=acc['proxy'])
        if not valid:
             # Even if invalid, we applied it, but let's notify
             db[index]['status'] = 'failed'
             save_db(db)
             raise HTTPException(status_code=400, detail=f"Failed to apply: {info}")
        
        session.organization_id = org_id
        db[index]['status'] = 'connected'
        db[index]['org_id'] = org_id
        save_db(db)
        sync_pool() # Update the active session pool
        return {"status": "success", "org_id": org_id, "email": acc['email']}
    raise HTTPException(status_code=404, detail="Account not found")

@app.post("/api/db/accounts/validate-all", dependencies=[Depends(verify_auth)])
async def validate_all_accounts():
    db = load_db()
    for acc in db:
        valid, org_id, info = validate_key(acc['key'], proxy_url=acc['proxy'])
        if valid:
            acc['status'] = 'connected'
            acc['org_id'] = org_id
        else:
            acc['status'] = 'failed'
            logger.warning(f"Account {acc['email']} validation failed: {info}")
    save_db(db)
    sync_pool() # Update the active session pool
    return {"status": "success", "count": len(db)}


# --- End DB Management ---

@app.get("/api/proxies", dependencies=[Depends(verify_auth)])
async def list_proxies():
    return session.proxy_pool.all_proxies()

@app.post("/api/proxies", dependencies=[Depends(verify_auth)])
async def add_proxy(req: ProxyAddRequest):
    valid, err = _parse_proxy_url(req.url)
    if not valid:
        raise HTTPException(status_code=400, detail=err)
    
    ok, ip, test_err = _test_proxy(req.url)
    if not ok:
        raise HTTPException(status_code=400, detail=f"Proxy test failed: {test_err}")
    
    added = session.proxy_pool.add(req.url)
    if not added:
        return {"status": "exists", "ip": ip}
    
    session._sync_proxy()
    logger.info(f"Proxy added and session synced. Active: {session.proxy_pool.active}")
    return {"status": "added", "ip": ip}

@app.delete("/api/proxies/{proxy_id}", dependencies=[Depends(verify_auth)])
async def delete_proxy(proxy_id: int):
    removed = session.proxy_pool.remove(proxy_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Proxy not found")
    session._sync_proxy()
    return {"status": "removed"}

@app.post("/api/chat", dependencies=[Depends(verify_auth)])
async def chat(req: ChatRequest):
    logger.info(f"Chat request received: {req.message[:50]}... with {len(req.attachments)} attachments")
    
    if session.busy:
        logger.warning("Chat request rejected: Claude is already thinking")
        raise HTTPException(status_code=429, detail="Claude is already thinking. Please wait for the current response to finish.")

    if not session.session_key:
        logger.error("Chat failed: Session key not configured")
        raise HTTPException(status_code=400, detail="Session key not configured. Please go to Settings.")

    if not session.organization_id:
        logger.error("Chat failed: Organization ID missing")
        raise HTTPException(status_code=400, detail="Organization ID missing. Please re-save your settings.")

    def event_generator():
        try:
            logger.info("Starting Claude stream...")
            for chunk in send_message_stream(session, req.message, attachments=req.attachments):
                yield f"data: {json.dumps({'text': chunk})}\n\n"
        except Exception as e:
            logger.exception("Claude stream error")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/api/upload", dependencies=[Depends(verify_auth)])
async def upload_file(file: UploadFile = File(...)):
    """
    Handle file uploads. Text files are read and returned as 'content'.
    Images are processed for Claude's image attachment format.
    """
    try:
        content = await file.read()
        filename = file.filename
        content_type = file.content_type
        
        # 1. Handle Images
        if content_type.startswith("image/"):
            import base64
            b64_data = base64.b64encode(content).decode("utf-8")
            return {
                "file_name": filename,
                "file_size": len(content),
                "file_type": content_type,
                "image_data": b64_data
            }
            
        # 2. Handle Text Files
        try:
            text_content = content.decode("utf-8")
            return {
                "file_name": filename,
                "file_size": len(content),
                "file_type": content_type,
                "extracted_content": text_content
            }
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="File must be text or an image.")
            
    except Exception as e:
        logger.exception("Upload error")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat/new", dependencies=[Depends(verify_auth)])
async def new_chat():
    session.conversation_id = ""
    return {"status": "success"}
