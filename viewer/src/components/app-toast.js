// <app-toast>: transient notifications with an optional action button.

export class AppToast extends HTMLElement {
  connectedCallback() {
    this.setAttribute('role', 'status');
    this.setAttribute('aria-live', 'polite');
  }

  /**
   * @param {string} message
   * @param {{action?: string, onAction?: () => void, duration?: number, kind?: 'info'|'error'}} options
   */
  show(message, { action, onAction, duration = 3500, kind = 'info' } = {}) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(text);
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action;
      btn.addEventListener('click', () => { onAction?.(); toast.remove(); });
      toast.append(btn);
    }
    this.append(toast);
    const timer = setTimeout(() => toast.remove(), action ? Math.max(duration, 8000) : duration);
    toast.addEventListener('click', (e) => { if (e.target === toast) { clearTimeout(timer); toast.remove(); } });
    return toast;
  }
}

customElements.define('app-toast', AppToast);
