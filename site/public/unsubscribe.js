// Deletes the subscriber named by the signed token in the fragment, after a click.
const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get('u');

const done = (title, lead) => {
  history.replaceState(null, '', location.pathname);
  $('un-title').textContent = title;
  $('un-lead').textContent = lead;
  $('un-actions').replaceChildren(Object.assign(document.createElement('a'), { className: 'btn secondary', href: '/', textContent: 'Back to Codemm' }));
};

if (!token) {
  done('This link isn\'t complete.', 'Use the full link from your email.');
} else {
  $('un-confirm').addEventListener('click', async () => {
    $('un-confirm').disabled = true;
    try {
      const res = await fetch('/api/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return done('Your email is deleted.', 'You won\'t get any more emails from Codemm.');
      $('un-status').textContent = data.error ?? 'Something went wrong. Try again.';
      $('un-status').className = 'gate-status error';
    } catch {
      $('un-status').textContent = 'Couldn\'t reach Codemm. Try again.';
      $('un-status').className = 'gate-status error';
    }
    $('un-confirm').disabled = false;
  });
}
