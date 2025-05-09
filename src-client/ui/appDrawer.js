import { elements } from '../domElements.js';
import { globalState } from '../state.js';
import { sendWebSocketMessage } from '../websocketService.js';
import { openPanel, closeActivePanel } from './taskbarControls.js';

function showPage(pageNumber) {
	let targetPage = parseInt(pageNumber, 10);
	if (isNaN(targetPage) || targetPage <= 0) targetPage = 1;
	if (targetPage > globalState.totalPages && globalState.totalPages > 0) targetPage = globalState.totalPages;
	if (globalState.totalPages === 0) targetPage = 1;

	if (elements.appGridContainer) {
        if (globalState.totalPages > 0) {
            elements.appGridContainer.style.transform = `translateX(-${(targetPage - 1) * (100 / globalState.totalPages)}%)`;
        } else {
            elements.appGridContainer.style.transform = 'translateX(0%)';
        }
    }

    if (elements.paginationContainer && elements.paginationContainer.childNodes) {
        Array.from(elements.paginationContainer.childNodes).forEach((dot, index) => {
            if (dot.classList) dot.classList.toggle('active', index === targetPage - 1);
        });
    }

	globalState.currentPage = targetPage;
}

function openAppDrawerInternal() {
    openPanel('appDrawer');
	showPage(globalState.currentPage || 1);
}

function closeAppDrawerInternal() {
    if (globalState.activePanel === 'appDrawer') {
	    closeActivePanel();
    }
}

export function renderAppDrawer(apps) {
    if (!elements.appGridContainer || !elements.paginationContainer) return;

	elements.appGridContainer.innerHTML = '';

	globalState.allApps = apps || [];

	if (globalState.allApps.length > 0) {
        globalState.totalPages = 1;
        globalState.appsPerPage = globalState.allApps.length;
    } else {
        globalState.totalPages = 0;
        globalState.appsPerPage = 0;
    }

	if (globalState.allApps.length === 0) {
		const noAppsMessage = document.createElement('div');
		noAppsMessage.textContent = 'No applications found.';
		noAppsMessage.style.textAlign = 'center'; noAppsMessage.style.width = '100%';
		noAppsMessage.style.padding = '20px';
		elements.appGridContainer.appendChild(noAppsMessage);
        elements.appGridContainer.style.width = '100%';
	} else {
		elements.appGridContainer.style.width = `${globalState.totalPages * 100}%`;

		for (let i = 0; i < globalState.totalPages; i++) {
			const pageDiv = document.createElement('div');
			pageDiv.classList.add('app-grid');
			pageDiv.id = `appGridPage${i + 1}`;
			pageDiv.style.width = `${100 / globalState.totalPages}%`;

			const pageApps = globalState.allApps.slice(i * globalState.appsPerPage, (i + 1) * globalState.appsPerPage);
			pageApps.forEach(app => {
				const button = document.createElement('button');
				button.classList.add('app-button');
				button.setAttribute('data-package-name', app.packageName);
				button.setAttribute('title', `${app.label} (${app.packageName})`);
				const iconDiv = document.createElement('div');
				iconDiv.classList.add('app-icon'); iconDiv.textContent = app.letter || '?';
				const labelSpan = document.createElement('span'); labelSpan.textContent = app.label;
				button.appendChild(iconDiv); button.appendChild(labelSpan);
				button.addEventListener('click', (e) => {
					e.stopPropagation();
					sendWebSocketMessage({ action: 'launchApp', packageName: app.packageName });
					closeAppDrawerInternal();
				});
				pageDiv.appendChild(button);
			});
			elements.appGridContainer.appendChild(pageDiv);
		}
	}

    elements.paginationContainer.innerHTML = '';
	if (globalState.totalPages > 1) {
        elements.paginationContainer.style.display = 'flex';
		for (let i = 0; i < globalState.totalPages; i++) {
			const dot = document.createElement('span');
			dot.classList.add('dot'); dot.setAttribute('data-page', i + 1);
			dot.addEventListener('click', (e) => { e.stopPropagation(); showPage(i + 1); });
			elements.paginationContainer.appendChild(dot);
		}
	} else {
        elements.paginationContainer.style.display = 'none';
    }

	if (globalState.currentPage > globalState.totalPages && globalState.totalPages > 0) {
        globalState.currentPage = globalState.totalPages;
    } else if (globalState.currentPage <= 0 && globalState.totalPages > 0) {
        globalState.currentPage = 1;
    } else if (globalState.totalPages === 0) {
        globalState.currentPage = 1;
    }
	showPage(globalState.currentPage);
}


export function initAppDrawer() {
    if (elements.appDrawerButton) {
        elements.appDrawerButton.addEventListener('click', (e) => {
	        e.stopPropagation();
	        if (globalState.activePanel === 'appDrawer') closeAppDrawerInternal();
	        else openAppDrawerInternal();
        });
    }
    renderAppDrawer([]);
}