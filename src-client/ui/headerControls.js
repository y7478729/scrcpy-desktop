import { elements } from '../domElements.js';
import { globalState } from '../state.js';
import { HIDE_HEADER_TIMEOUT_MS } from '../constants.js';


function showPageHeader() {
	if (elements.header?.classList.contains('hidden')) elements.header.classList.remove('hidden');
}

function hidePageHeader() {
	if (!globalState.isHeaderMouseOver && elements.header && !elements.header.classList.contains('hidden')) {
        elements.header.classList.add('hidden');
    }
}

function resetHeaderTimeout() {
	clearTimeout(globalState.headerScrollTimeout);
	globalState.headerScrollTimeout = setTimeout(hidePageHeader, HIDE_HEADER_TIMEOUT_MS);
}


export function initHeaderControls() {
    if (elements.themeToggle) {
        elements.themeToggle.addEventListener('click', () => {
	        const body = document.body;
	        const currentTheme = body.getAttribute('data-theme');
	        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
	        body.setAttribute('data-theme', newTheme);
	        elements.themeToggle.setAttribute('aria-checked', newTheme === 'dark' ? 'true' : 'false');
        });
        elements.themeToggle.setAttribute('aria-checked', document.body.getAttribute('data-theme') === 'dark' ? 'true' : 'false');
    }

    if (elements.fullscreenBtn && elements.streamArea) {
        elements.fullscreenBtn.addEventListener('click', () => {
	        if (!document.fullscreenElement) {
		        if (globalState.isRunning && elements.videoElement?.classList.contains('visible')) {
                    elements.streamArea.requestFullscreen().catch(e => {});
                }
	        } else {
                document.exitFullscreen();
            }
        });
    }

    document.addEventListener('fullscreenchange', () => {
        if (elements.streamArea) {
	        elements.streamArea.classList.toggle('in-fullscreen-mode', document.fullscreenElement === elements.streamArea);
        }
    });

    window.addEventListener('scroll', () => {
	    showPageHeader(); resetHeaderTimeout();
    });

    if (elements.header) {
        elements.header.addEventListener('mouseenter', () => {
	        globalState.isHeaderMouseOver = true; clearTimeout(globalState.headerScrollTimeout); showPageHeader();
        });
        elements.header.addEventListener('mouseleave', () => {
	        globalState.isHeaderMouseOver = false; resetHeaderTimeout();
        });
    }

    showPageHeader();
    resetHeaderTimeout();
}