(function() {
  if (window.__CC_WIDGET_LOADED) return;
  window.__CC_WIDGET_LOADED = true;

  // Find configuration from script tag
  const currentScript = document.currentScript || (function() {
    const scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  const serverOrigin = (currentScript && currentScript.src) 
    ? new URL(currentScript.src).origin 
    : window.location.origin;

  const wsId = (currentScript && (
    currentScript.getAttribute('data-ws') ||
    currentScript.getAttribute('data-workspace') ||
    currentScript.getAttribute('data-tenant') ||
    currentScript.getAttribute('data-workspace-id')
  )) || '';
  const primaryColor = (currentScript && currentScript.getAttribute('data-color')) || '#1A0B2E';

  // Build chat URL
  const chatUrl = new URL(serverOrigin + '/chat.html');
  chatUrl.searchParams.set('embedded', '1');
  if (wsId) {
    chatUrl.searchParams.set('ws', wsId);
    chatUrl.searchParams.set('tenant', wsId);
  }

  // Inject Styles
  const style = document.createElement('style');
  style.textContent = `
    .cc-chat-widget-container {
      position: fixed;
      bottom: 22px;
      right: 22px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .cc-chat-bubble-btn {
      width: 58px;
      height: 58px;
      border-radius: 50%;
      background: ${primaryColor};
      color: #FFB7A5;
      border: 1.5px solid rgba(255, 183, 165, 0.45);
      box-shadow: 0 8px 24px -4px rgba(26, 11, 46, 0.45), 0 0 16px -2px rgba(255, 183, 165, 0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s;
    }
    .cc-chat-bubble-btn:hover {
      transform: scale(1.08);
      box-shadow: 0 12px 30px -4px rgba(0, 0, 0, 0.45);
    }
    .cc-chat-bubble-btn svg {
      width: 26px;
      height: 26px;
      fill: currentColor;
      transition: transform 0.2s;
    }
    .cc-chat-window-frame {
      position: fixed;
      bottom: 92px;
      right: 22px;
      width: 400px;
      max-width: calc(100vw - 44px);
      height: 600px;
      max-height: calc(100vh - 120px);
      border-radius: 20px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      box-shadow: 0 20px 48px -8px rgba(0, 0, 0, 0.35);
      background: #0d121f;
      overflow: hidden;
      display: none;
      opacity: 0;
      transform: translateY(16px) scale(0.96);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 2147483646;
    }
    .cc-chat-window-frame.open {
      display: block;
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    .cc-chat-window-frame iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }
    @media (max-width: 480px) {
      .cc-chat-window-frame {
        bottom: 0;
        right: 0;
        width: 100vw;
        max-width: 100vw;
        height: 100vh;
        max-height: 100vh;
        border-radius: 0;
      }
    }
  `;
  document.head.appendChild(style);

  // Create Widget DOM
  const container = document.createElement('div');
  container.className = 'cc-chat-widget-container';

  const btn = document.createElement('button');
  btn.className = 'cc-chat-bubble-btn';
  btn.setAttribute('aria-label', 'Open AI Assistant');
  btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;

  const frameBox = document.createElement('div');
  frameBox.className = 'cc-chat-window-frame';

  let iframeLoaded = false;
  let isOpen = false;

  function toggleChat() {
    isOpen = !isOpen;
    if (isOpen) {
      if (!iframeLoaded) {
        const iframe = document.createElement('iframe');
        iframe.src = chatUrl.toString();
        iframe.title = 'AI Assistant';
        frameBox.appendChild(iframe);
        iframeLoaded = true;
      }
      frameBox.classList.add('open');
      btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    } else {
      frameBox.classList.remove('open');
      btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;
    }
  }

  btn.addEventListener('click', toggleChat);
  container.appendChild(btn);
  document.body.appendChild(container);
  document.body.appendChild(frameBox);
})();
