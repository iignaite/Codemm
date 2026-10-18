// The email gate on the landing page.
const MIN_MS = 3200; // the server refuses a submit sooner than 3 s after the form token

const form = document.getElementById('get');
const input = document.getElementById('email');
const button = document.getElementById('gate-submit');
const status = document.getElementById('gate-status');

let state = { token: null, issued: 0, available: null };

async function loadForm() {
  try {
    const res = await fetch('/api/form', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const data = await res.json();
    state = { token: data.token, issued: Date.now(), available: data.available };
    if (data.available === false) {
      document.getElementById('gate-note').textContent = 'The beta is on its way. We\'ll email you when it\'s out; unsubscribe anytime.';
      button.textContent = 'Notify me';
    }
  } catch {
    state.token = null;
  }
}

const say = (text, kind) => {
  status.textContent = text;
  status.className = `gate-status ${kind ?? ''}`;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!input.checkValidity()) {
    input.setAttribute('aria-invalid', 'true');
    say('Enter a valid email address.', 'error');
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  if (!state.token) await loadForm();
  if (!state.token) return say('Couldn\'t reach Codemm. Check your connection and try again.', 'error');

  button.disabled = true;
  say('One moment.');
  try {
    await wait(Math.max(0, state.issued + MIN_MS - Date.now()));
    const res = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: input.value, token: state.token, company: form.elements.company.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 400) await loadForm();
      if (res.status === 400 && /valid email/.test(data.error ?? '')) input.setAttribute('aria-invalid', 'true');
      return say(data.error ?? 'Something went wrong. Try again.', 'error');
    }
    if (state.available === false) {
      form.classList.add('done');
      return say('You\'re on the list. We\'ll email you when the beta is out.', 'ok');
    }
    // The token travels in the fragment, which never reaches a server or a Referer header.
    location.assign(`/downloads#${new URLSearchParams({ d: data.download })}`);
  } catch {
    say('Couldn\'t reach Codemm. Check your connection and try again.', 'error');
  } finally {
    button.disabled = false;
  }
});

input.addEventListener('input', () => {
  if (input.hasAttribute('aria-invalid') && input.checkValidity()) {
    input.removeAttribute('aria-invalid');
    say('');
  }
});

// Links to #get land on the form ready to type.
document.addEventListener('click', (e) => {
  if (e.target.closest('a[href="#get"]')) setTimeout(() => input.focus({ preventScroll: true }), 400);
});

// The button stays disabled until this handler is attached, so the form never submits natively.
button.disabled = false;
loadForm();
