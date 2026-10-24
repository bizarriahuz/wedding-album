// Copy and Share buttons for link boxes.
// Markup: <div class="linkbox"><input class="link" readonly> <button data-copy>Copy</button> <button data-share>Share</button></div>
// Copy tries the clipboard API, then the older execCommand route, and finally
// selects the text so the person can long-press and copy it themselves.

(function () {
  const canShare = typeof navigator.share === 'function';

  function flash(btn, text) {
    const old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1800);
  }

  function legacyCopy(input) {
    input.focus();
    input.select();
    input.setSelectionRange(0, input.value.length);
    try { return document.execCommand('copy'); } catch { return false; }
  }

  async function copy(input, btn) {
    try {
      await navigator.clipboard.writeText(input.value);
      flash(btn, 'Copied');
    } catch {
      if (legacyCopy(input)) flash(btn, 'Copied');
      else flash(btn, 'Selected'); // text is left selected for a long-press copy
    }
  }

  // Tapping the link field selects all of it, ready to copy by hand
  document.addEventListener('focusin', (e) => {
    if (e.target.matches?.('input.link')) setTimeout(() => e.target.select(), 0);
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-copy], button[data-share]');
    if (!btn) return;
    const input = btn.closest('.linkbox').querySelector('input.link');
    if (!input.value) return;

    if (btn.hasAttribute('data-share')) {
      try { await navigator.share({ title: document.title, url: input.value }); }
      catch (err) { if (err.name !== 'AbortError') copy(input, btn); }
    } else {
      copy(input, btn);
    }
  });

  // Share only shows where the phone supports it
  document.querySelectorAll('button[data-share]').forEach((b) => {
    if (!canShare) b.classList.add('hidden');
  });
})();
