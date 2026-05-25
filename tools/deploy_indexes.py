"""
Deploy Firestore composite indexes via Admin REST API.
Uses service account key for authentication.
"""
import json
import requests
import google.auth
import google.auth.transport.requests
from google.oauth2 import service_account

KEY_FILE = 'D:/taiwan-ramen-association.github.io/ramen-finder-notes/taiwan-ramen-association-firebase-adminsdk-fbsvc-8e7be69ca9.json'
PROJECT   = 'taiwan-ramen-association'
DB        = '(default)'
BASE      = f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/{DB}/collectionGroups'

SCOPES = ['https://www.googleapis.com/auth/datastore',
          'https://www.googleapis.com/auth/cloud-platform']

# ── 取 access token ────────────────────────────────────────────────────────────
creds = service_account.Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
auth_req = google.auth.transport.requests.Request()
creds.refresh(auth_req)
token = creds.token
headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

# ── 要建立的 indexes ────────────────────────────────────────────────────────────
INDEXES = [
    {
        'collection': 'reviews',
        'body': {
            'queryScope': 'COLLECTION',
            'fields': [
                {'fieldPath': 'uid',       'order': 'ASCENDING'},
                {'fieldPath': 'createdAt', 'order': 'DESCENDING'},
            ]
        }
    },
    {
        'collection': 'menus',
        'body': {
            'queryScope': 'COLLECTION',
            'fields': [
                {'fieldPath': 'uid',       'order': 'ASCENDING'},
                {'fieldPath': 'createdAt', 'order': 'DESCENDING'},
            ]
        }
    },
]

# ── 先查詢現有 indexes，避免重複建立 ───────────────────────────────────────────
def list_indexes(collection):
    url = f'{BASE}/{collection}/indexes'
    r = requests.get(url, headers=headers)
    if r.status_code != 200:
        print(f'  [WARN] 查詢 {collection} 索引失敗: {r.status_code} {r.text[:200]}')
        return []
    return r.json().get('indexes', [])

def index_exists(existing, fields_spec):
    """檢查是否已有相同 fields 的索引"""
    target = [(f['fieldPath'], f.get('order','')) for f in fields_spec]
    for idx in existing:
        existing_fields = [(f['fieldPath'], f.get('order','')) for f in idx.get('fields', []) if f.get('fieldPath') != '__name__']
        if existing_fields == target:
            return True, idx.get('name',''), idx.get('state','')
    return False, '', ''

# ── 執行部署 ────────────────────────────────────────────────────────────────────
for spec in INDEXES:
    col = spec['collection']
    fields_spec = spec['body']['fields']
    print(f'\n[{col}] uid + createdAt')

    existing = list_indexes(col)
    exists, name, state = index_exists(existing, fields_spec)

    if exists:
        print(f'  [OK] already exists (state={state})')
        print(f'     {name}')
        continue

    url = f'{BASE}/{col}/indexes'
    r = requests.post(url, headers=headers, json=spec['body'])
    if r.status_code in (200, 201):
        op = r.json()
        print(f'  [CREATING] operation: {op.get("name","?")}')
    elif r.status_code == 409:
        print(f'  [OK] already exists (409)')
    else:
        print(f'  [FAIL] status={r.status_code}')
        print(f'     {r.text[:400]}')

print('\nDone. Indexes usually take a few minutes. Check status at:')
print(f'https://console.firebase.google.com/project/{PROJECT}/firestore/indexes')
