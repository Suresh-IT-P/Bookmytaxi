/**
 * BookMyTaxi Clone - Core Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
    // State
    let currentCategory = 'daily'; // 'daily', 'outstation', 'rentals'
    let pricing = null;
    let map, pickupMarker, dropMarker, routeLine;
    let pickupCoords = null;
    let dropCoords = null;
    let selectedVehicle = null;
    let selectedPackage = '2-20'; // Default for rentals

    // Check Auth
    const user = JSON.parse(localStorage.getItem('cityride_member'));
    if (user) {
        const dashBtn = document.getElementById('top-dashboard-btn');
        if (dashBtn) dashBtn.style.display = 'block';
    }

    // Elements
    const pickupInput = document.getElementById('pickup');
    const dropInput = document.getElementById('drop');
    const vehicleList = document.getElementById('vehicle-list');
    const summarySection = document.getElementById('selected-vehicle-summary');
    const displayFare = document.getElementById('display-fare');
    const bookBtn = document.getElementById('book-btn');
    const tabBtns = document.querySelectorAll('.nav-item');

    // Initialize Map
    initMap();

    // Tab Switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCategory = btn.dataset.tab;
            
            // UI Adjustments for different modes
            if (currentCategory === 'rentals') {
                document.getElementById('drop-wrapper').style.display = 'none';
                document.getElementById('rental-pkg-container').classList.remove('hidden');
                dropInput.required = false;
            } else {
                document.getElementById('drop-wrapper').style.display = 'flex';
                document.getElementById('rental-pkg-container').classList.add('hidden');
                dropInput.required = true;
            }
            updateView();
        });
    });

    // Package Selection
    document.querySelectorAll('.pkg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pkg-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedPackage = btn.dataset.pkg;
            updateView();
        });
    });

    // Autocomplete Setup
    setupAutocomplete('pickup', 'pickup-suggestions');
    setupAutocomplete('drop', 'drop-suggestions');

    // Live Location
    document.getElementById('current-location-btn').addEventListener('click', useLiveLocation);

    // Fetch Tariffs
    fetchTariffs();

    // Map Picker Tool
    document.getElementById('map-picker-btn').addEventListener('click', () => {
        alert('Click anywhere on the map to set your destination.');
    });

    // Functions
    async function initMap() {
        map = L.map('map', {
            zoomControl: false,
            attributionControl: false
        }).setView([13.0827, 80.2707], 13);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            maxZoom: 20
        }).addTo(map);

        map.on('click', (e) => {
            const { lat, lng } = e.latlng;
            if (!pickupCoords) {
                setPickup(lat, lng);
            } else {
                setDrop(lat, lng);
            }
        });
    }

    async function fetchTariffs() {
        try {
            const res = await fetch(`${API_BASE_URL}/api/tariffs`);
            const data = await res.json();
            
            const transformed = {};
            data.forEach(t => {
                if (!transformed[t.vehicle_type]) {
                    const displayInfo = {
                    bike: { name: 'Bike', desc: 'Affordable, quick rides', img: 'https://cdn-icons-png.flaticon.com/512/3198/3198336.png' },
                    sedan: { name: 'Mini', desc: 'Comfy, AC compacts', img: 'https://cdn-icons-png.flaticon.com/512/3202/3202926.png' },
                    suv: { name: 'Prime SUV', desc: 'Spacious SUVs', img: 'https://cdn-icons-png.flaticon.com/512/3085/3085330.png' }
                };
                    transformed[t.vehicle_type] = { ...displayInfo[t.vehicle_type] };
                }
                transformed[t.vehicle_type][t.category] = typeof t.config === 'string' ? JSON.parse(t.config) : t.config;
            });
            pricing = transformed;
        } catch (err) {
            console.error('Tariff fetch failed', err);
        }
    }

    async function updateView() {
        if (!pickupCoords || (currentCategory !== 'rentals' && !dropCoords)) {
            vehicleList.innerHTML = '<div class="placeholder-text">Enter locations to see available rides</div>';
            summarySection.classList.add('hidden');
            return;
        }

        try {
            let distance = 0;
            if (pickupCoords && dropCoords) {
                const res = await fetch(`${API_BASE_URL}/api/proxy/route?pickup=${pickupCoords}&drop=${dropCoords}`);
                const data = await res.json();
                if (data.routes && data.routes.length > 0) {
                    distance = Math.ceil(data.routes[0].distance / 1000);
                    drawRoute(data.routes[0].geometry);
                }
            }
            renderVehicles(distance);
        } catch (err) {
            console.error('Update view error', err);
        }
    }

    function renderVehicles(distance) {
        if (!pricing) return;
        vehicleList.innerHTML = '';
        
        const categoryKey = currentCategory === 'daily' ? 'local' : (currentCategory === 'outstation' ? 'oneway' : 'rental');

        Object.keys(pricing).forEach(vType => {
            const info = pricing[vType];
            const config = info[categoryKey];
            if (!config) return;

            let fare = 0;
            if (categoryKey === 'local') {
                fare = Math.max(config.base, config.base + (distance * config.perKm)) * 1.05;
            } else if (categoryKey === 'oneway') {
                fare = (Math.max(distance, 130) * config.perKm + 400) * 1.05;
            } else if (categoryKey === 'rental') {
                const pkg = config[selectedPackage] || config['2-20'];
                fare = pkg.base * 1.05;
            }

            fare = Math.ceil(fare);

            const card = document.createElement('div');
            card.className = 'vehicle-card';
            card.innerHTML = `
                <div class="v-icon"><img src="${info.img}" alt="${vType}"></div>
                <div class="v-details">
                    <div class="v-name">${info.name} <span class="v-time">3 min</span></div>
                    <div class="v-desc">${info.desc}</div>
                </div>
                <div class="v-price-wrap">
                    <div class="v-price">₹${fare}</div>
                </div>
            `;

            card.onclick = () => {
                document.querySelectorAll('.vehicle-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedVehicle = { type: vType, fare: fare, distance: distance };
                displayFare.textContent = `₹${fare}`;
                summarySection.classList.remove('hidden');
            };

            vehicleList.appendChild(card);
        });
    }

    function setupAutocomplete(inputId, suggestionBoxId) {
        const input = document.getElementById(inputId);
        const box = document.getElementById(suggestionBoxId);
        let timeout = null;

        input.addEventListener('input', () => {
            clearTimeout(timeout);
            const query = input.value;
            if (query.length < 3) { box.innerHTML = ''; return; }

            timeout = setTimeout(async () => {
                try {
                    const res = await fetch(`${API_BASE_URL}/api/proxy/geocode?q=${encodeURIComponent(query)}&limit=5`);
                    const data = await res.json();
                    box.innerHTML = '';
                    if (data.features) {
                        data.features.forEach(f => {
                            const p = f.properties;
                            const c = f.geometry.coordinates;
                            const label = [p.name, p.city].filter(Boolean).join(', ');
                            const item = document.createElement('div');
                            item.className = 'suggestion-item';
                            item.textContent = label;
                            item.onclick = () => {
                                input.value = label;
                                if (inputId === 'pickup') setPickup(c[1], c[0], label);
                                else setDrop(c[1], c[0], label);
                                box.innerHTML = '';
                            };
                            box.appendChild(item);
                        });
                    }
                } catch (e) {}
            }, 300);
        });
    }

    function setPickup(lat, lng, label) {
        pickupCoords = `${lng},${lat}`;
        if (pickupMarker) map.removeLayer(pickupMarker);
        pickupMarker = L.marker([lat, lng], {
            icon: L.divIcon({ className: 'dot-green', html: '<div style="width:12px;height:12px;background:#4caf50;border-radius:50%;border:2px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.2);"></div>' })
        }).addTo(map);
        map.setView([lat, lng], 15);
        if (label) pickupInput.value = label;
        else reverseGeocode(lat, lng, pickupInput);
        updateView();
    }

    function setDrop(lat, lng, label) {
        dropCoords = `${lng},${lat}`;
        if (dropMarker) map.removeLayer(dropMarker);
        dropMarker = L.marker([lat, lng], {
            icon: L.divIcon({ className: 'dot-red', html: '<div style="width:12px;height:12px;background:#ff5252;border-radius:50%;border:2px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.2);"></div>' })
        }).addTo(map);
        if (label) dropInput.value = label;
        else reverseGeocode(lat, lng, dropInput);
        updateView();
    }

    async function reverseGeocode(lat, lng, input) {
        try {
            const res = await fetch(`${API_BASE_URL}/api/proxy/reverse?lon=${lng}&lat=${lat}`);
            const data = await res.json();
            if (data.features && data.features.length > 0) {
                const p = data.features[0].properties;
                input.value = [p.name, p.city].filter(Boolean).join(', ');
            }
        } catch (e) {}
    }

    function drawRoute(geometry) {
        if (routeLine) map.removeLayer(routeLine);
        // Simple OSRM geometry is encoded or coordinates? Proxy OSRM returns coordinates in geometry if requested.
        // Project OSRM returns polyline by default.
        // For simplicity, let's just use the markers to bound the view for now if geometry is complex.
        const bounds = L.latLngBounds([pickupMarker.getLatLng(), dropMarker.getLatLng()]);
        map.fitBounds(bounds, { padding: [50, 50] });
    }

    function useLiveLocation() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(pos => {
                setPickup(pos.coords.latitude, pos.coords.longitude);
            });
        }
    }

    bookBtn.addEventListener('click', async () => {
        const user = JSON.parse(localStorage.getItem('cityride_member'));
        if (!user) {
            window.location.href = 'auth.html';
            return;
        }

        const bookingData = {
            userId: user.id,
            pickup: pickupInput.value,
            pickupCoords: pickupCoords,
            drop: dropInput.value,
            dropCoords: dropCoords,
            date: new Date().toISOString().split('T')[0],
            time: new Date().toTimeString().split(' ')[0].substring(0, 5),
            passengers: 1,
            vehicle: selectedVehicle.type,
            tripType: currentCategory === 'daily' ? 'local' : (currentCategory === 'outstation' ? 'oneway' : 'rental'),
            fare: `₹${selectedVehicle.fare}`,
            distance: `${selectedVehicle.distance} KM`
        };

        try {
            const res = await fetch(`${API_BASE_URL}/api/bookings/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bookingData)
            });
            if (res.ok) {
                const result = await res.json();
                alert(`Booking Successful! ID: #B${result.bookingId}\nOTP: ${result.journeyOtp}`);
                window.location.href = 'dashboard.html';
            }
        } catch (err) {
            alert('Booking failed. Please try again.');
        }
    });
});
