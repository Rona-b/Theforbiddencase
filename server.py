"""Optional shared club server. Run behind HTTPS when hosted. See README.md."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import uuid
import io
import subprocess
import tempfile
from PIL import Image, UnidentifiedImageError
import imageio_ffmpeg
from datetime import date
from urllib.parse import urlparse

from flask import Flask, abort, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent

def read_content():
    """content.js contains a JSON-compatible object after its assignment."""
    source=(ROOT/'content.js').read_text(encoding='utf-8')
    marker='window.CLUB_CONTENT ='
    if marker not in source:raise ValueError('Missing window.CLUB_CONTENT assignment in content.js')
    return json.loads(source.split(marker,1)[1].strip().removesuffix(';'))

def text(value, limit, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError('Check the required text fields and their lengths.')
    return value.strip()

def valid_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value) or value in ('__proto__','constructor','prototype'):
        raise ValueError('Invalid item ID.')
    return value

def image_path(value):
    value = text(value, 1600000)
    if not value:
        return ''
    if re.fullmatch(r'data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+', value):
        return value
    if re.fullmatch(r'images/[A-Za-z0-9_./-]+\.(png|jpe?g|webp|svg)', value, re.I) and '..' not in value:
        return value
    if urlparse(value).scheme == 'https' and urlparse(value).netloc:
        return value
    raise ValueError('Invalid image path. Use images/, HTTPS, or an uploaded image.')

def validate_config(value):
    if not isinstance(value,dict) or value.get('version') != 1:
        raise ValueError('Invalid website content.')
    out={'version':1,'name':text(value.get('name'),100,True),'tagline':text(value.get('tagline'),200),'about':text(value.get('about'),3000)}
    def book(v,current=False):
        if not isinstance(v,dict):raise ValueError('Invalid book.')
        b={'id':valid_id(v.get('id')),'title':text(v.get('title'),150,True),'author':text(v.get('author'),150,True),'cover':image_path(v.get('cover'))}
        if current:
            n=v.get('chapters')
            if type(n) is not int or not 1 <= n <= 1000:raise ValueError('Chapter count must be 1–1000.')
            b.update(chapters=n,description=text(v.get('description'),3000))
        return b
    themes={'auto','original','01-january','02-february','03-march','04-april','05-may','06-june','07-july','08-august','09-september','10-october','11-november','12-december'}
    theme=value.get('theme','auto')
    if theme not in themes:raise ValueError('Choose a valid decoration theme.')
    out['theme']=theme
    out['current']=book(value.get('current'),True)
    upcoming=value.get('upcoming');announcements=value.get('announcements');events=value.get('events')
    if not isinstance(upcoming,list) or len(upcoming)>12:raise ValueError('Maximum 12 upcoming books.')
    out['upcoming']=[book(b) for b in upcoming]
    if len({b['id'] for b in out['upcoming']})!=len(out['upcoming']):raise ValueError('Book IDs must be unique.')
    if not isinstance(announcements,list) or len(announcements)>20:raise ValueError('Maximum 20 announcements.')
    out['announcements']=[text(a,500,True) for a in announcements]
    if not isinstance(events,list) or len(events)>20:raise ValueError('Maximum 20 events.')
    out['events']=[]
    for event in events:
        if not isinstance(event,dict):raise ValueError('Invalid event.')
        link=text(event.get('link'),500)
        if link and (urlparse(link).scheme!='https' or not urlparse(link).netloc):raise ValueError('Meeting links must use HTTPS.')
        out['events'].append({'id':valid_id(event.get('id')),'title':text(event.get('title'),150,True),'date':text(event.get('date'),200),'description':text(event.get('description'),1500),'link':link})
    if len({e['id'] for e in out['events']})!=len(out['events']):raise ValueError('Event IDs must be unique.')
    return out

def create_app(data_dir=None, secure_cookie=True):
    app=Flask(__name__,static_folder=None)
    data=Path(data_dir or os.environ.get('CLUB_DATA_DIR', ROOT/'data')).resolve()
    data.mkdir(parents=True,exist_ok=True)
    upload_dir=data/'uploads';upload_dir.mkdir(exist_ok=True)
    secret_path=data/'secret.key'
    if not secret_path.exists():
        try:
            with secret_path.open('x') as f:f.write(secrets.token_hex(32))
            secret_path.chmod(0o600)
        except FileExistsError:pass
    app.config.update(SECRET_KEY=os.environ.get('CLUB_SECRET') or secret_path.read_text().strip(),SESSION_COOKIE_HTTPONLY=True,SESSION_COOKIE_SAMESITE='Lax',SESSION_COOKIE_SECURE=secure_cookie,MAX_CONTENT_LENGTH=24*1024*1024,PERMANENT_SESSION_LIFETIME=86400*7,DATA_DIR=data)
    if os.environ.get('CLUB_TRUST_PROXY')=='1':
        from werkzeug.middleware.proxy_fix import ProxyFix
        app.wsgi_app=ProxyFix(app.wsgi_app,x_for=0,x_proto=1,x_host=0,x_port=0,x_prefix=0)
    dbpath=data/'club.sqlite3'
    with sqlite3.connect(dbpath) as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT NOT NULL,revision INTEGER NOT NULL,join_code TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,bio TEXT NOT NULL DEFAULT '',password TEXT NOT NULL,role TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,book_id TEXT NOT NULL,book_title TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,spoiler INTEGER NOT NULL,created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS replies(id TEXT PRIMARY KEY,post_id TEXT NOT NULL,user_id TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS likes(user_id TEXT NOT NULL,post_id TEXT NOT NULL,PRIMARY KEY(user_id,post_id));
        CREATE TABLE IF NOT EXISTS progress(user_id TEXT NOT NULL,book_id TEXT NOT NULL,chapter INTEGER NOT NULL,PRIMARY KEY(user_id,book_id));
        CREATE TABLE IF NOT EXISTS votes(user_id TEXT NOT NULL,book_id TEXT NOT NULL,choice TEXT NOT NULL,PRIMARY KEY(user_id,book_id));
        CREATE TABLE IF NOT EXISTS rsvps(user_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(user_id,event_id));
        CREATE TABLE IF NOT EXISTS attempts(ip TEXT NOT NULL,created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS content_history(revision INTEGER PRIMARY KEY,content TEXT NOT NULL,created REAL NOT NULL);
        ''')
        cols={r[1] for r in db.execute('PRAGMA table_info(users)')}
        for name, definition in [('status', "TEXT NOT NULL DEFAULT 'active'"), ('adult_attested', 'INTEGER NOT NULL DEFAULT 0'), ('terms_version', "TEXT NOT NULL DEFAULT ''")]:
            if name not in cols:db.execute(f'ALTER TABLE users ADD COLUMN {name} {definition}')
        db.execute("UPDATE users SET status='pending' WHERE role!='owner' AND adult_attested=0")
        db.executescript("CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS banned_names(username TEXT PRIMARY KEY);")
        chat_cols={r[1] for r in db.execute('PRAGMA table_info(chat)')}
        for name,definition in [('channel', "TEXT NOT NULL DEFAULT 'tavern'"), ('media_id', 'TEXT')]:
            if name not in chat_cols:db.execute(f'ALTER TABLE chat ADD COLUMN {name} {definition}')
        if 'spoiler' not in {r[1] for r in db.execute('PRAGMA table_info(chat)')}:
            db.execute('ALTER TABLE chat ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0')
        db.executescript("CREATE TABLE IF NOT EXISTS tavern_comments(id TEXT PRIMARY KEY,post_id INTEGER NOT NULL,user_id TEXT NOT NULL,body TEXT NOT NULL,spoiler INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS tavern_comment_post ON tavern_comments(post_id,created); CREATE TABLE IF NOT EXISTS tavern_reactions(user_id TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(user_id,kind,target));")
        db.executescript("CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS chat_channel_id ON chat(channel,id); CREATE TABLE IF NOT EXISTS art_comments(id TEXT PRIMARY KEY,post_id INTEGER NOT NULL,user_id TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS art_comment_post ON art_comments(post_id,created);")
        if not db.execute('SELECT id FROM settings').fetchone():
            seed=validate_config(read_content())
            db.execute('INSERT INTO settings VALUES(1,?,?,?)',(json.dumps(seed),1,secrets.token_urlsafe(12)))
    with sqlite3.connect(dbpath) as db:
        seed=validate_config(read_content())
        db.execute('UPDATE settings SET content=?,revision=revision+1 WHERE id=1',(json.dumps(seed),))
    def connection():
        if 'db' not in g:
            g.db=sqlite3.connect(dbpath,timeout=15)
            g.db.row_factory=sqlite3.Row
        return g.db
    @app.teardown_appcontext
    def close_db(_error):
        db=g.pop('db',None)
        if db is not None:db.close()
    def settings():return connection().execute('SELECT * FROM settings WHERE id=1').fetchone()
    def user(required=False):
        row=connection().execute('SELECT * FROM users WHERE id=?',(session.get('user_id',''),)).fetchone()
        if required and row is None:abort(401,description='Sign in to participate.')
        if required and row['role']!='owner' and row['status']!='active':abort(403,description='Membership approval is required.')
        return row
    def owner():
        u=user(True)
        if u['role']!='owner':abort(403,description='Only the owner can update website content.')
        return u
    def payload():
        value=request.get_json(silent=True)
        if not isinstance(value,dict):abort(400,description='Send a JSON object.')
        return value
    @app.before_request
    def protect_writes():
        if request.path.startswith('/api/') and request.method not in ('GET','HEAD','OPTIONS'):
            if request.headers.get('X-CSRF-Token') != session.get('csrf') or not session.get('csrf'):abort(403,description='Refresh the page and try again.')
            if not request.is_json and not (request.path=='/api/media' and request.mimetype=='multipart/form-data'):abort(415,description='JSON requests required, except media uploads.')
            origin=request.headers.get('Origin')
            if origin and origin.rstrip('/')!=request.host_url.rstrip('/'):abort(403,description='Cross-origin request denied.')
    @app.after_request
    def headers(response):
        if request.path.endswith('.js'):response.headers['Content-Type']='text/javascript; charset=utf-8'
        if request.path.endswith('.css'):response.headers['Content-Type']='text/css; charset=utf-8'
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['X-Frame-Options']='SAMEORIGIN'
        response.headers['Referrer-Policy']='same-origin'
        if request.path.startswith(('/api/','/media/')) or request.path=='/content.js':response.headers['Cache-Control']='no-store'
        return response
    @app.errorhandler(ValueError)
    def invalid(error):return jsonify(error=str(error)),400
    @app.errorhandler(400)
    @app.errorhandler(401)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(409)
    @app.errorhandler(413)
    @app.errorhandler(415)
    @app.errorhandler(429)
    def http_error(error):return jsonify(error=error.description),error.code
    @app.get('/')
    @app.get('/index.html')
    def home():return send_from_directory(ROOT,'index.html')
    @app.get('/content.js')
    def content_file():return app.response_class('window.CLUB_SERVER = true;\nwindow.CLUB_CONTENT = '+settings()['content']+';\n',mimetype='text/javascript')
    @app.get('/images/<path:name>')
    def images(name):return send_from_directory(ROOT/'images',name)
    @app.get('/<name>')
    def static_files(name):
        if name not in {'tavern.css','tavern.js','fan-art.css','fan-art.js','MOBILE-MONTHLY-GALLERY.html','PREVIEW-MOBILE.html','responsive.css','navigation.js','pages.js','pages.css','current-read.html','discussions.html','upcoming-books.html','members.html','events.html','shop.html','about.html','announcements.html','polls.html','fan-art.html','tavern.html','rules.html','profile.html','search.html','sign-in.html','admin.html','styles.css','script.js','members.js','club.js','MONTHLY-GALLERY.html'}:abort(404)
        return send_from_directory(ROOT,name)
    @app.get('/api/config')
    def public_config():
        s=settings()
        return jsonify(config=json.loads(s['content']),revision=s['revision'])
    @app.get('/api/me')
    def me():
        session.setdefault('csrf',secrets.token_urlsafe(32));u=user();s=settings()
        result={'csrf':session['csrf'],'revision':s['revision'],'user':dict(id=u['id'],name=u['name'],username=u['username'],role=u['role'],bio=u['bio'],status=u['status']) if u else None}
        if u and u['role']=='owner':result['joinCode']=s['join_code']
        return jsonify(result)
    def auth_limit():
        db=connection();now=time.time();ip=request.remote_addr or 'unknown'
        db.execute('DELETE FROM attempts WHERE created<?',(now-900,))
        n=db.execute('SELECT COUNT(*) FROM attempts WHERE ip=?',(ip,)).fetchone()[0]
        if n>=15:abort(429,description='Too many sign-in attempts. Try again in 15 minutes.')
        db.execute('INSERT INTO attempts VALUES(?,?)',(ip,now));db.commit()
    @app.post('/api/register')
    def register():
        auth_limit();v=payload();s=settings()
        try:born=date.fromisoformat(v.get('birthDate',''))
        except (ValueError,TypeError):raise ValueError('Enter a valid date of birth.')
        today=date.today();age=today.year-born.year-((today.month,today.day)<(born.month,born.day))
        if age<18 or age>120:abort(403,description='This club is for adults aged 18 or older.')
        if v.get('adultConsent')!='yes':abort(403,description='Accept the adult membership rules first.')
        code=text(v.get('joinCode'),200,True)
        if not secrets.compare_digest(code,s['join_code']):abort(403,description='Ask the club owner for the correct invitation code.')
        username=text(v.get('username'),60,True).lower()
        if not re.fullmatch(r'[a-z0-9_.-]{3,60}',username):raise ValueError('Username must have 3–60 letters, numbers, dots, underscores, or hyphens.')
        if connection().execute('SELECT 1 FROM banned_names WHERE username=?',(username,)).fetchone():abort(403,description='Registration is unavailable for this username.')
        name=text(v.get('name'),60,True);password=text(v.get('password'),256,True)
        if len(password)<12:raise ValueError('Use a password of at least 12 characters.')
        uid=str(uuid.uuid4());db=connection()
        try:db.execute('INSERT INTO users(id,username,name,password,role,status,adult_attested,terms_version) VALUES(?,?,?,?,?,?,?,?)',(uid,username,name,generate_password_hash(password),'member','pending',1,'2026-10-11'));db.commit()
        except sqlite3.IntegrityError:abort(409,description='That username is already taken.')
        session.clear();session.update(user_id=uid,csrf=secrets.token_urlsafe(32));session.permanent=True
        return jsonify(ok=True)
    @app.post('/api/login')
    def login():
        auth_limit();v=payload();username=text(v.get('username'),60,True).lower();password=text(v.get('password'),256,True)
        u=connection().execute('SELECT * FROM users WHERE username=?',(username,)).fetchone()
        if not u or not check_password_hash(u['password'],password):abort(401,description='Incorrect username or password.')
        session.clear();session.update(user_id=u['id'],csrf=secrets.token_urlsafe(32));session.permanent=True
        return jsonify(ok=True)
    @app.post('/api/logout')
    def logout():session.clear();return jsonify(ok=True)
    @app.get('/api/state')
    def state():
        u=user(True);db=connection();posts=[]
        for p in db.execute('SELECT p.*,u.name author FROM posts p JOIN users u ON p.user_id=u.id ORDER BY created DESC LIMIT 500'):
            replies=[dict(author=r['author'],body=r['body']) for r in db.execute('SELECT r.body,u.name author FROM replies r JOIN users u ON r.user_id=u.id WHERE post_id=? ORDER BY r.created,r.id LIMIT 500',(p['id'],))]
            liked=bool(db.execute('SELECT 1 FROM likes WHERE user_id=? AND post_id=?',(u['id'],p['id'])).fetchone())
            posts.append(dict(id=p['id'],bookId=p['book_id'],bookTitle=p['book_title'],author=p['author'],title=p['title'],body=p['body'],spoiler=bool(p['spoiler']),created=p['created'],liked=liked,replies=replies,canDelete=p['user_id']==u['id'] or u['role']=='owner'))
        progress={r['book_id']:r['chapter'] for r in db.execute('SELECT * FROM progress WHERE user_id=?',(u['id'],))}
        votes={r['book_id']:r['choice'] for r in db.execute('SELECT * FROM votes WHERE user_id=?',(u['id'],))}
        rsvps=[r['event_id'] for r in db.execute('SELECT * FROM rsvps WHERE user_id=?',(u['id'],))]
        members=[dict(name=r['name'],bio=r['bio']) for r in db.execute('SELECT name,bio FROM users ORDER BY name LIMIT 500')]
        c=json.loads(settings()['content'])
        totals={r['choice']:r['n'] for r in db.execute('SELECT choice,COUNT(*) n FROM votes WHERE book_id=? GROUP BY choice',(c['current']['id'],))}
        return jsonify(reader=dict(profile=dict(name=u['name'],bio=u['bio']),progress=progress,votes=votes,rsvps=rsvps,posts=posts),members=members,totals=totals)
    @app.put('/api/content')
    def save_content():
        abort(403,description='Update content.js in your code files, then restart the server.')
    @app.get('/api/admin/users')
    def admin_users():
        owner()
        return jsonify(users=[dict(r) for r in connection().execute('SELECT id,username,name,role,status,adult_attested FROM users ORDER BY name')])
    @app.post('/api/admin/users/<uid>/approve')
    def approve_user(uid):
        owner();db=connection()
        r=db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
        if not r:abort(404)
        if not r['adult_attested']:abort(403,description='Member must complete the adult declaration by registering again.')
        db.execute("UPDATE users SET status='active' WHERE id=?",(uid,));db.commit();return jsonify(ok=True)
    @app.delete('/api/admin/users/<uid>')
    def remove_user(uid):
        owner();db=connection();r=db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
        if not r:abort(404)
        if r['role']=='owner':abort(403,description='Owner accounts cannot be removed here.')
        db.execute('INSERT OR IGNORE INTO banned_names VALUES(?)',(r['username'],))
        for row in db.execute('SELECT id FROM posts WHERE user_id=?',(uid,)).fetchall():
            db.execute('DELETE FROM replies WHERE post_id=?',(row['id'],));db.execute('DELETE FROM likes WHERE post_id=?',(row['id'],))
        for media in db.execute('SELECT filename FROM media WHERE user_id=?',(uid,)).fetchall():
            (upload_dir/media['filename']).unlink(missing_ok=True)
        db.execute('DELETE FROM media WHERE user_id=?',(uid,))
        db.execute('DELETE FROM art_comments WHERE user_id=? OR post_id IN (SELECT id FROM chat WHERE user_id=?)',(uid,uid))
        for post in db.execute("SELECT id FROM chat WHERE user_id=? AND channel='tavern'",(uid,)).fetchall():cleanup_tavern_post(db,post['id'])
        for comment in db.execute('SELECT id FROM tavern_comments WHERE user_id=?',(uid,)).fetchall():db.execute("DELETE FROM tavern_reactions WHERE kind='comment' AND target=?",(comment['id'],))
        db.execute('DELETE FROM tavern_comments WHERE user_id=?',(uid,));db.execute('DELETE FROM tavern_reactions WHERE user_id=?',(uid,))
        for table in ['posts','replies','likes','progress','votes','rsvps','chat']:
            db.execute(f'DELETE FROM {table} WHERE user_id=?',(uid,))
        db.execute('DELETE FROM users WHERE id=?',(uid,))
        db.execute('UPDATE settings SET join_code=? WHERE id=1',(secrets.token_urlsafe(12),))
        db.commit();return jsonify(ok=True)
    def chat_channel(value):
        if value not in ('tavern','art'):raise ValueError('Unknown chat room.')
        return value
    def delete_attachment(db,media_id):
        if not media_id:return
        if db.execute('SELECT 1 FROM chat WHERE media_id=?',(media_id,)).fetchone():return
        item=db.execute('SELECT * FROM media WHERE id=?',(media_id,)).fetchone()
        if item:
            (upload_dir/item['filename']).unlink(missing_ok=True)
            db.execute('DELETE FROM media WHERE id=?',(media_id,))
    @app.post('/api/media')
    def media_upload():
        u=user(True);f=request.files.get('file')
        if not f:raise ValueError('Choose an image, GIF, or video.')
        raw=f.read(20*1024*1024+1)
        if not raw or len(raw)>20*1024*1024:raise ValueError('Maximum video size is 20 MB; images and GIFs are limited to 8 MB.')
        suffix=Path(f.filename or '').suffix.lower();mime=None
        image_formats={'.jpg':('JPEG','image/jpeg'),'.jpeg':('JPEG','image/jpeg'),'.png':('PNG','image/png'),'.webp':('WEBP','image/webp'),'.gif':('GIF','image/gif')}
        if suffix in image_formats:
            if len(raw)>8*1024*1024:raise ValueError('Images and GIFs must be 8 MB or smaller.')
            try:
                with Image.open(io.BytesIO(raw)) as im:
                    if im.format!=image_formats[suffix][0] or im.width*im.height>25000000 or getattr(im,'n_frames',1)>500:raise ValueError('Unsupported image dimensions, format, or animation length.')
                    im.verify()
            except (UnidentifiedImageError,OSError,Image.DecompressionBombError):raise ValueError('This image could not be read. Choose a valid JPG, PNG, WebP, or GIF.')
            mime=image_formats[suffix][1]
        elif suffix in ('.mp4','.webm'):
            if (suffix=='.mp4' and raw[4:8]!=b'ftyp') or (suffix=='.webm' and raw[:4]!=bytes.fromhex('1a45dfa3')):raise ValueError('Choose a valid MP4 or WebM video.')
            with tempfile.TemporaryDirectory() as video_temp:
                video_path=Path(video_temp)/('clip'+suffix);video_path.write_bytes(raw)
                try:
                    result=subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-nostdin','-i',str(video_path),'-map','0:v:0','-frames:v','1','-f','null','-'],capture_output=True,timeout=20)
                    if result.returncode:raise ValueError('This video could not be decoded. Export as MP4 (H.264) or WebM.')
                except subprocess.TimeoutExpired:raise ValueError('This video took too long to validate. Try a smaller clip.')
            mime='video/mp4' if suffix=='.mp4' else 'video/webm'
        else:raise ValueError('Supported uploads: JPG, PNG, WebP, GIF, MP4, and WebM.')
        db=connection();db.execute('BEGIN IMMEDIATE')
        # Remove abandoned uploads after a day, keeping shared files.
        for old in db.execute('SELECT id FROM media WHERE created<? AND id NOT IN (SELECT media_id FROM chat WHERE media_id IS NOT NULL)',(int(time.time()*1000)-86400000,)).fetchall():delete_attachment(db,old['id'])
        quota=int(os.environ.get('CLUB_MEDIA_QUOTA_MB','500'))*1024*1024
        total=db.execute('SELECT COALESCE(SUM(size),0) FROM media').fetchone()[0]
        if total+len(raw)>quota:db.rollback();abort(413,description='Club media storage is full. Ask the owner to remove old media.')
        if db.execute('SELECT COUNT(*) FROM media WHERE user_id=? AND created>?',(u['id'],int(time.time()*1000)-60000)).fetchone()[0]>=10:db.rollback();abort(429,description='Please wait before uploading more files.')
        mid=uuid.uuid4().hex;filename=mid+suffix;target=upload_dir/filename
        try:
            target.write_bytes(raw)
            db.execute('INSERT INTO media VALUES(?,?,?,?,?,?)',(mid,u['id'],filename,mime,len(raw),int(time.time()*1000)));db.commit()
        except Exception:
            db.rollback();target.unlink(missing_ok=True);raise
        return jsonify(id=mid,url='/media/'+mid,mime=mime),201
    @app.get('/media/<mid>')
    def media_file(mid):
        u=user(True);db=connection();item=db.execute('SELECT * FROM media WHERE id=?',(mid,)).fetchone()
        if not item:abort(404)
        if item['user_id']!=u['id'] and u['role']!='owner' and not db.execute('SELECT 1 FROM chat WHERE media_id=?',(mid,)).fetchone():abort(403)
        return send_from_directory(upload_dir,item['filename'],mimetype=item['mime'],conditional=True)
    @app.delete('/api/media/<mid>')
    def cancel_media(mid):
        u=user(True);db=connection();item=db.execute('SELECT * FROM media WHERE id=?',(mid,)).fetchone()
        if not item:abort(404)
        if u['role']!='owner' and item['user_id']!=u['id']:abort(403)
        if db.execute('SELECT 1 FROM chat WHERE media_id=?',(mid,)).fetchone():abort(409,description='Remove the message to delete its attachment.')
        delete_attachment(db,mid);db.commit();return jsonify(ok=True)
    @app.get('/api/chat')
    def chat_read():
        u=user(True);channel=chat_channel(request.args.get('channel','tavern'))
        try:after=max(0,int(request.args.get('after',0)))
        except ValueError:raise ValueError('Invalid chat cursor.')
        db=connection()
        query='SELECT c.*,u.name,m.mime FROM chat c JOIN users u ON u.id=c.user_id LEFT JOIN media m ON m.id=c.media_id WHERE c.channel=?'
        if after:rows=db.execute(query+' AND c.id>? ORDER BY c.id LIMIT 200',(channel,after)).fetchall()
        else:rows=list(reversed(db.execute(query+' ORDER BY c.id DESC LIMIT 100',(channel,)).fetchall()))
        return jsonify(messages=[dict(id=r['id'],name=r['name'],body=r['body'],created=r['created'],channel=r['channel'],canDelete=u['role']=='owner' or u['id']==r['user_id'],media=dict(id=r['media_id'],mime=r['mime'],url='/media/'+r['media_id']) if r['mime'] else None) for r in rows])
    @app.post('/api/chat')
    def chat_send():
        u=user(True);v=payload();body=text(v.get('body',''),1500);channel=chat_channel(v.get('channel','tavern'));mid=v.get('mediaId');db=connection();now=int(time.time()*1000)
        if not body and not mid:raise ValueError('Write a message or attach a file.')
        if mid:
            if not isinstance(mid,str) or not re.fullmatch(r'[a-f0-9]{32}',mid):raise ValueError('Invalid attachment.')
            media=db.execute('SELECT * FROM media WHERE id=? AND user_id=?',(mid,u['id'])).fetchone()
            if not media:abort(403,description='You can only share your own uploaded attachment.')
            if db.execute('SELECT 1 FROM chat WHERE media_id=?',(mid,)).fetchone():abort(409,description='This upload is already shared. Upload another copy.')
        if db.execute('SELECT COUNT(*) FROM chat WHERE user_id=? AND created>?',(u['id'],now-10000)).fetchone()[0]>=5:abort(429,description='Please slow down before sending another message.')
        spoiler=v.get('spoiler',False)
        if type(spoiler)is not bool:abort(400,description='Spoiler must be true or false.')
        db.execute('INSERT INTO chat(user_id,body,created,channel,media_id,spoiler) VALUES(?,?,?,?,?,?)',(u['id'],body,now,channel,mid,int(spoiler)));db.commit();return jsonify(ok=True),201
    @app.delete('/api/chat/<int:mid>')
    def chat_delete(mid):
        u=user(True);db=connection();msg=db.execute('SELECT * FROM chat WHERE id=?',(mid,)).fetchone()
        if not msg:abort(404)
        if u['role']!='owner' and u['id']!=msg['user_id']:abort(403)
        cleanup_tavern_post(db,mid)
        db.execute('DELETE FROM art_comments WHERE post_id=?',(mid,));db.execute('DELETE FROM chat WHERE id=?',(mid,));delete_attachment(db,msg['media_id']);db.commit();return jsonify(ok=True)
    def cleanup_tavern_post(db,pid):
        db.execute("DELETE FROM tavern_reactions WHERE kind='comment' AND target IN (SELECT id FROM tavern_comments WHERE post_id=?)",(pid,))
        db.execute("DELETE FROM tavern_reactions WHERE kind='post' AND target=?",(str(pid),))
        db.execute('DELETE FROM tavern_comments WHERE post_id=?',(pid,))
    def tavern_target(db,kind,target):
        if kind=='post':row=db.execute("SELECT * FROM chat WHERE id=? AND channel='tavern'",(target,)).fetchone()
        elif kind=='comment':row=db.execute('SELECT * FROM tavern_comments WHERE id=?',(target,)).fetchone()
        else:abort(400)
        if not row:abort(404)
        return row
    @app.get('/api/tavern-feed')
    def tavern_feed():
        u=user(True);db=connection()
        try:before=int(request.args.get('before',9223372036854775807))
        except ValueError:abort(400)
        def reactions(kind,target):
            return [dict(emoji=r['emoji'],count=r['n'],mine=bool(r['mine'])) for r in db.execute('SELECT emoji,COUNT(*) n,MAX(user_id=?) mine FROM tavern_reactions WHERE kind=? AND target=? GROUP BY emoji',(u['id'],kind,str(target)))]
        selected=request.args.get('post')
        if selected is not None:
            try:selected=int(selected)
            except ValueError:abort(400)
        rows=db.execute("SELECT c.*,u.name,m.mime FROM chat c JOIN users u ON u.id=c.user_id LEFT JOIN media m ON m.id=c.media_id WHERE c.channel='tavern' AND c.id<? AND (? IS NULL OR c.id=?) ORDER BY c.id DESC LIMIT 20",(before,selected,selected)).fetchall();posts=[]
        for r in rows:
            comments=db.execute('SELECT c.*,u.name FROM tavern_comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.created,c.id',(r['id'],)).fetchall()
            posts.append(dict(id=r['id'],name=r['name'],body=r['body'],created=r['created'],spoiler=bool(r['spoiler']),canDelete=u['role']=='owner' or u['id']==r['user_id'],reactions=reactions('post',r['id']),media=dict(url='/media/'+r['media_id'],mime=r['mime']) if r['mime'] else None,comments=[dict(id=c['id'],name=c['name'],body=c['body'],created=c['created'],spoiler=bool(c['spoiler']),reactions=reactions('comment',c['id']),canDelete=u['role']=='owner' or u['id']==c['user_id']) for c in comments]))
        return jsonify(posts=posts,nextBefore=rows[-1]['id'] if len(rows)==20 else None)
    @app.post('/api/tavern-feed/<int:pid>/comments')
    def tavern_comment(pid):
        u=user(True);db=connection();parent=tavern_target(db,'post',pid);v=payload();body=text(v.get('body'),1500,True);spoiler=v.get('spoiler',False)
        if type(spoiler)is not bool:abort(400)
        now=int(time.time()*1000)
        if db.execute('SELECT COUNT(*) FROM tavern_comments WHERE user_id=? AND created>?',(u['id'],now-10000)).fetchone()[0]>=5:abort(429,description='Please slow down before commenting again.')
        db.execute('INSERT INTO tavern_comments VALUES(?,?,?,?,?,?)',(uuid.uuid4().hex,pid,u['id'],body,int(spoiler or bool(parent['spoiler'])),now));db.commit();return jsonify(ok=True),201
    @app.delete('/api/tavern-comments/<cid>')
    def remove_tavern_comment(cid):
        u=user(True);db=connection();c=tavern_target(db,'comment',cid)
        if u['role']!='owner' and u['id']!=c['user_id']:abort(403)
        db.execute("DELETE FROM tavern_reactions WHERE kind='comment' AND target=?",(cid,));db.execute('DELETE FROM tavern_comments WHERE id=?',(cid,));db.commit();return jsonify(ok=True)
    @app.post('/api/tavern-reactions/<kind>/<target>')
    def react_tavern(kind,target):
        u=user(True);db=connection();tavern_target(db,kind,target);emoji=payload().get('emoji')
        if emoji not in ['❤️','😂','📚','✨','👍']:abort(400)
        old=db.execute('SELECT emoji FROM tavern_reactions WHERE user_id=? AND kind=? AND target=?',(u['id'],kind,target)).fetchone()
        if old and old['emoji']==emoji:db.execute('DELETE FROM tavern_reactions WHERE user_id=? AND kind=? AND target=?',(u['id'],kind,target))
        else:db.execute('INSERT OR REPLACE INTO tavern_reactions VALUES(?,?,?,?)',(u['id'],kind,target,emoji))
        db.commit();return jsonify(ok=True)
    @app.get('/api/art-feed')
    def art_feed():
        u=user(True);db=connection()
        try:before=int(request.args.get('before',9223372036854775807))
        except ValueError:abort(400)
        rows=db.execute("SELECT c.*,u.name,m.mime FROM chat c JOIN users u ON u.id=c.user_id LEFT JOIN media m ON m.id=c.media_id WHERE c.channel='art' AND c.id<? ORDER BY c.id DESC LIMIT 20",(before,)).fetchall()
        posts=[]
        for r in rows:
            comments=db.execute('SELECT a.*,u.name FROM art_comments a JOIN users u ON u.id=a.user_id WHERE a.post_id=? ORDER BY a.created,a.id',(r['id'],)).fetchall()
            posts.append(dict(id=r['id'],name=r['name'],body=r['body'],created=r['created'],canDelete=u['role']=='owner' or u['id']==r['user_id'],media=dict(url='/media/'+r['media_id'],mime=r['mime']) if r['mime'] else None,comments=[dict(id=c['id'],name=c['name'],body=c['body'],created=c['created'],canDelete=u['role']=='owner' or u['id']==c['user_id']) for c in comments]))
        return jsonify(posts=posts,nextBefore=rows[-1]['id'] if len(rows)==20 else None)
    @app.post('/api/art-feed/<int:pid>/comments')
    def art_comment(pid):
        u=user(True);db=connection();body=text(payload().get('body'),1500,True);now=int(time.time()*1000)
        if not db.execute("SELECT id FROM chat WHERE id=? AND channel='art'",(pid,)).fetchone():abort(404)
        if db.execute('SELECT COUNT(*) FROM art_comments WHERE user_id=? AND created>?',(u['id'],now-10000)).fetchone()[0]>=5:abort(429,description='Please slow down before commenting again.')
        db.execute('INSERT INTO art_comments VALUES(?,?,?,?,?)',(uuid.uuid4().hex,pid,u['id'],body,now));db.commit();return jsonify(ok=True),201
    @app.delete('/api/art-comments/<cid>')
    def art_comment_delete(cid):
        u=user(True);db=connection();c=db.execute('SELECT * FROM art_comments WHERE id=?',(cid,)).fetchone()
        if not c:abort(404)
        if u['role']!='owner' and u['id']!=c['user_id']:abort(403)
        db.execute('DELETE FROM art_comments WHERE id=?',(cid,));db.commit();return jsonify(ok=True)
    @app.put('/api/profile')
    def profile():
        u=user(True);v=payload();name=text(v.get('name'),60,True);bio=text(v.get('bio'),500);db=connection()
        db.execute('UPDATE users SET name=?,bio=? WHERE id=?',(name,bio,u['id']));db.commit();return jsonify(ok=True)
    @app.post('/api/posts')
    def post():
        u=user(True);v=payload();c=json.loads(settings()['content'])['current']
        if v.get('bookId')!=c['id']:abort(409,description='The current book changed. Reload and check the selection.')
        title=text(v.get('title'),150,True);body=text(v.get('body'),3000,True)
        if type(v.get('spoiler'))is not bool:raise ValueError('Invalid spoiler setting.')
        db=connection();db.execute('INSERT INTO posts VALUES(?,?,?,?,?,?,?,?)',(str(uuid.uuid4()),u['id'],c['id'],c['title'],title,body,int(v['spoiler']),int(time.time()*1000)));db.commit();return jsonify(ok=True),201
    @app.post('/api/posts/<pid>/replies')
    def reply(pid):
        u=user(True);v=payload();body=text(v.get('body'),1500,True);db=connection()
        if not db.execute('SELECT id FROM posts WHERE id=?',(pid,)).fetchone():abort(404,description='Conversation not found.')
        db.execute('INSERT INTO replies VALUES(?,?,?,?,?)',(str(uuid.uuid4()),pid,u['id'],body,int(time.time()*1000)));db.commit();return jsonify(ok=True),201
    @app.post('/api/posts/<pid>/like')
    def like(pid):
        u=user(True);db=connection()
        if not db.execute('SELECT id FROM posts WHERE id=?',(pid,)).fetchone():abort(404)
        exists=db.execute('SELECT 1 FROM likes WHERE user_id=? AND post_id=?',(u['id'],pid)).fetchone()
        if exists:db.execute('DELETE FROM likes WHERE user_id=? AND post_id=?',(u['id'],pid))
        else:db.execute('INSERT INTO likes VALUES(?,?)',(u['id'],pid))
        db.commit();return jsonify(ok=True)
    @app.delete('/api/posts/<pid>')
    def delete_post(pid):
        u=user(True);db=connection();p=db.execute('SELECT user_id FROM posts WHERE id=?',(pid,)).fetchone()
        if not p:abort(404)
        if u['role']!='owner' and p['user_id']!=u['id']:abort(403)
        db.execute('DELETE FROM replies WHERE post_id=?',(pid,));db.execute('DELETE FROM likes WHERE post_id=?',(pid,));db.execute('DELETE FROM posts WHERE id=?',(pid,));db.commit();return jsonify(ok=True)
    @app.put('/api/progress')
    def progress():
        u=user(True);v=payload();c=json.loads(settings()['content'])['current'];chapter=v.get('chapter')
        if v.get('bookId')!=c['id']:abort(409,description='The current book changed. Reload before tracking.')
        if type(chapter)is not int or not 0<=chapter<=c['chapters']:raise ValueError('Invalid chapter.')
        db=connection();db.execute('INSERT OR REPLACE INTO progress VALUES(?,?,?)',(u['id'],c['id'],chapter));db.commit();return jsonify(ok=True)
    @app.put('/api/vote')
    def vote():
        u=user(True);v=payload();c=json.loads(settings()['content'])
        if v.get('bookId')!=c['current']['id'] or v.get('choice')not in {b['id'] for b in c['upcoming']}:abort(409,description='The book list changed. Reload before voting.')
        db=connection();db.execute('INSERT OR REPLACE INTO votes VALUES(?,?,?)',(u['id'],c['current']['id'],v['choice']));db.commit();return jsonify(ok=True)
    @app.post('/api/rsvp')
    def rsvp():
        u=user(True);v=payload();eid=v.get('eventId');c=json.loads(settings()['content'])
        if eid not in {e['id']for e in c['events']}:abort(404,description='Event not found.')
        db=connection();exists=db.execute('SELECT 1 FROM rsvps WHERE user_id=? AND event_id=?',(u['id'],eid)).fetchone()
        if exists:db.execute('DELETE FROM rsvps WHERE user_id=? AND event_id=?',(u['id'],eid))
        else:db.execute('INSERT INTO rsvps VALUES(?,?)',(u['id'],eid))
        db.commit();return jsonify(ok=True)
    app.club_database=dbpath
    return app

app=create_app(secure_cookie=os.environ.get('CLUB_LOCAL')!='1')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description='The Forbidden Case shared member server')
    parser.add_argument('--setup-owner',action='store_true',help='Create/reset the owner account from this computer')
    parser.add_argument('--local',action='store_true',help='Run on localhost for testing in VS Code')
    parser.add_argument('--port',type=int,default=8000)
    parser.add_argument('--reset-member',help='Reset a member password by username from the server console')
    parser.add_argument('--backup',type=Path,help='Write a consistent SQLite database backup')
    args=parser.parse_args()
    if args.backup:
        with sqlite3.connect(app.club_database) as src,sqlite3.connect(args.backup) as dst:src.backup(dst)
        print('Database backup created:',args.backup)
    elif args.reset_member:
        password=getpass.getpass('New member password (at least 12 characters): ')
        repeated=getpass.getpass('Repeat password: ')
        if password!=repeated or not 12<=len(password)<=256:raise SystemExit('Invalid password or passwords did not match.')
        with sqlite3.connect(app.club_database) as db:
            found=db.execute('SELECT id FROM users WHERE username=?',(args.reset_member.lower(),)).fetchone()
            if not found:raise SystemExit('Username not found.')
            db.execute('UPDATE users SET password=? WHERE id=?',(generate_password_hash(password),found[0]))
        print('Member password reset. Give the member the new password privately.')
    elif args.setup_owner:
        username=input('Owner username (letters/numbers, 3–60 characters): ').strip().lower()
        name=input('Your reader/display name: ').strip()
        password=getpass.getpass('Owner password (at least 12 characters): ')
        confirm_password=getpass.getpass('Repeat password: ')
        if not re.fullmatch(r'[a-z0-9_.-]{3,60}',username) or not name or len(name)>60 or len(password)<12 or len(password)>256 or password!=confirm_password:raise SystemExit('Invalid details or passwords did not match. Try setup again.')
        with sqlite3.connect(app.club_database) as db:
            existing=db.execute('SELECT id,role FROM users WHERE username=?',(username,)).fetchone()
            if existing and existing[1]!='owner':raise SystemExit('That username belongs to a member. Choose a different owner username.')
            if existing:db.execute('UPDATE users SET name=?,password=? WHERE id=?',(name,generate_password_hash(password),existing[0]))
            else:db.execute('INSERT INTO users(id,username,name,password,role) VALUES(?,?,?,?,?)',(str(uuid.uuid4()),username,name,generate_password_hash(password),'owner'))
            code=db.execute('SELECT join_code FROM settings WHERE id=1').fetchone()[0]
        print('Owner account ready. Club invitation code:',code)
        print('Next: python server.py --local')
    else:
        with sqlite3.connect(app.club_database) as db:
            if not db.execute("SELECT 1 FROM users WHERE role='owner'").fetchone():raise SystemExit('Create your owner account first: python server.py --setup-owner')
        if args.local:app.config['SESSION_COOKIE_SECURE']=False
        from waitress import serve
        host='127.0.0.1' if args.local else os.environ.get('CLUB_BIND','127.0.0.1')
        print(f'Open http://{host}:{args.port} in your browser. Ctrl+C stops the server.')
        print('Hosted use requires HTTPS and a persistent data directory. See README.md.')
        serve(app,host=host,port=args.port,threads=4)
