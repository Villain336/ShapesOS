"""Seed Phase 3 demo data into the preview DB for Tico's tour. Skips records that already exist."""
import re, requests

def val(k):
    v = re.search(rf'^{k}=(.*)$', open('/home/hatch/workspace/marketr/.env').read(), re.M).group(1).strip()
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'' else v

BASE = 'http://localhost:3000'
s = requests.Session()
csrf = s.get(f'{BASE}/api/auth/csrf', timeout=10).json()['csrfToken']
r = s.post(f'{BASE}/api/auth/callback/credentials', data={
    'csrfToken': csrf, 'email': val('ADMIN_EMAIL'), 'password': val('ADMIN_PASSWORD'),
    'callbackUrl': f'{BASE}/dashboard',
}, timeout=15, allow_redirects=False)
loc = r.headers.get('location', '')
assert '/dashboard' in loc and 'error' not in loc, f'login failed: {loc[:120]}'
print('login ok')

def get(path):
    return s.get(f'{BASE}{path}', timeout=15).json()

def post(path, body):
    r = s.post(f'{BASE}{path}', json=body, timeout=15)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text[:200]

# 1. Nurture sequence
seqs = get('/api/nurture/sequences').get('sequences', [])
if not any(x['name'] == 'New Lead Welcome' for x in seqs):
    code, res = post('/api/nurture/sequences', {
        'name': 'New Lead Welcome',
        'description': 'Speed-to-lead + 7-day warm-up for inbound leads.',
        'status': 'active',
        'dailyCap': 200,
        'steps': [
            {'channel': 'sms', 'delayMinutes': 5, 'template': 'Hi {{firstName}}, thanks for reaching out to {{company}}! What are you looking to get done?'},
            {'channel': 'email', 'delayMinutes': 1440, 'subject': 'Quick follow-up', 'template': '<p>Hi {{firstName}},</p><p>Just checking in — happy to walk through options whenever works for you.</p>'},
            {'channel': 'sms', 'delayMinutes': 4320, 'template': 'Hi {{firstName}}, still interested? Reply YES and we will set up a time.'},
        ],
    })
    print('sequence:', code, res.get('sequence', {}).get('id'))
else:
    print('sequence exists, skipping')

# 2. Prospect list + prospects
lists = get('/api/prospects/lists').get('lists', [])
lid = next((l['id'] for l in lists if l['name'] == 'Triad Home Services'), None)
if not lid:
    code, res = post('/api/prospects/lists', {
        'name': 'Triad Home Services',
        'icp': {'industries': ['HVAC', 'Plumbing', 'Roofing'], 'geo': 'Greensboro, NC',
                'employeeRange': '5-50', 'titles': ['Owner', 'General Manager']},
    })
    lid = res.get('list', {}).get('id')
    print('list:', code, lid)
    code2, res2 = post(f'/api/prospects/lists/{lid}/prospects', {'prospects': [
        {'company': 'Gate City Heating & Air', 'name': 'Marcus Webb', 'title': 'Owner',
         'website': 'gatecityhvac.example.com', 'phone': '+13365550101'},
        {'company': 'Piedmont Plumbing Co', 'name': 'Dana Ruiz', 'title': 'General Manager',
         'website': 'piedmontplumbing.example.com', 'email': 'dana@piedmontplumbing.example.com'},
        {'company': 'Triad Roofing Pros', 'name': 'Chris Bell', 'title': 'Owner',
         'website': 'triadroofing.example.com', 'phone': '+13365550102'},
    ]})
    print('  prospects:', code2, str(res2)[:100])
else:
    print('list exists, skipping')

# 3. Pipeline + lead + consent + review site config + review request
leads = get('/api/crm/leads').get('leads', [])
if not leads:
    code, res = post('/api/crm/pipelines', {'name': 'Main Pipeline', 'stages': [
        {'id': 'new', 'label': 'New', 'color': 'blue'},
        {'id': 'contacted', 'label': 'Contacted', 'color': 'amber'},
        {'id': 'won', 'label': 'Won', 'color': 'green'},
        {'id': 'lost', 'label': 'Lost', 'color': 'gray'},
    ]})
    pid = res.get('pipeline', {}).get('id')
    print('pipeline:', code, pid)
    code, res = post('/api/crm/leads', {
        'pipelineId': pid, 'name': 'Angela Foster', 'email': 'angela@example.com',
        'phone': '+13365550109', 'company': 'Foster Realty Group', 'source': 'website_form',
        'stage': 'new', 'valueCents': 250000,
    })
    lead = res.get('lead', {})
    print('lead:', code, lead.get('id'))
    for ch in ['sms', 'email']:
        post('/api/nurture/consent', {'leadId': lead.get('id'), 'channel': ch,
                                     'status': 'opted_in', 'source': 'website_form'})
    print('consent recorded')
else:
    lead = leads[0]
    print('lead exists:', lead['id'])

cfgs = get('/api/review-config').get('configs', [])
if not cfgs:
    code, _ = post('/api/review-config', {'site': 'google',
        'reviewUrl': 'https://www.google.com/maps/search/?api=1&query=Launchabl+Greensboro+NC',
        'delayDays': 1, 'enabled': True})
    print('review config:', code)
else:
    print('review config exists, skipping')

reqs = get('/api/review-requests').get('requests', [])
if not reqs and lead.get('id'):
    code, res = post('/api/review-requests', {'leadId': lead['id'], 'channel': 'sms', 'delayDays': 1})
    print('review request:', code, str(res)[:120])
else:
    print('review request exists or no lead, skipping')

print('done')
