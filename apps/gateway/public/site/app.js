const toggle = document.querySelector('.nav-toggle');
const links = document.querySelector('.nav-links');
toggle?.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!open));
  links?.classList.toggle('open', !open);
});

const form = document.querySelector('#contact-form');
const status = document.querySelector('#contact-status');
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  status.textContent = 'Sending…';
  const data = new FormData(form);
  try {
    const response = await fetch('/api/inquiries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: data.get('name'),
        email: data.get('email'),
        company: data.get('company') || undefined,
        message: data.get('message'),
        accepted_privacy: data.get('accepted_privacy') === 'on',
        website: data.get('website') || undefined,
      }),
    });
    if (!response.ok) throw new Error('request failed');
    form.reset();
    status.textContent = 'Thank you. Your inquiry has been received.';
  } catch {
    status.textContent =
      'We could not send the inquiry. Please email pokemnn@yahoo.co.jp.';
  } finally {
    button.disabled = false;
  }
});
