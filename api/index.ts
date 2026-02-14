import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import nodemailer from 'nodemailer'; 
import postgres from 'postgres';

// For Vercel serverless, we need to create connection per request or use connection pooling
const getDb = () => {
    if (!process.env.DATABASE_URL) {
        console.error("❌ DATABASE_URL missing");
        return null;
    }
    
    try {
        return postgres(process.env.DATABASE_URL, { 
            ssl: 'require',
            prepare: false,
            max: 1, // Serverless needs minimal connections
            idle_timeout: 20,
            connect_timeout: 10
        });
    } catch (err) {
        console.error("❌ DB Connection Error:", err);
        return null;
    }
};

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 465,
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

const BRANCH_LOCATIONS: Record<string, { lat: number, lng: number }> = {
    "HQ": { lat: 1.4845, lng: 103.7177 },
    "TUTA": { lat: 1.527164, lng: 103.668258 },
    "ANGSANA": { lat: 1.496179, lng: 103.705852 },
    "AEON PERMAS": { lat: 1.495621, lng: 103.817432 }
};

const ALLOWED_RADIUS_METERS = 30;

// Helper: Calculate distance in meters
function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

const app = new Elysia()
    .use(cors())
    .group('/api', app => app

        // 2. Get All Leaves
        .get('/admin/leaves', async ({ set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return []; }
            try {
                const leaves = await sql`
                    SELECT l.*, u.name as staff_name, u.branch 
                    FROM leaves l 
                    LEFT JOIN users u ON l.user_id = u.id 
                    ORDER BY l.created_at DESC
                `;
                await sql.end();
                return [...leaves];
            } catch (e) { 
                console.error("Admin Leaves Error:", e);
                try { await sql.end(); } catch(err) {}
                return []; 
            }
        })

        // 3. Update Leave Status
        .put('/admin/leaves/:id', async ({ params, body, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { success: false }; }
            
            const b = body as { status: string, reason?: string, admin_name: string };
            try {
                await sql`
                    UPDATE leaves 
                    SET status = ${b.status}, 
                        rejection_reason = ${b.reason || null},
                        approved_by = ${b.admin_name}
                    WHERE id = ${params.id}
                `;
                await sql.end();
                return { success: true };
            } catch (e) { 
                console.error("Leave Update Error:", e);
                try { await sql.end(); } catch(err) {}
                return { success: false, error: String(e) }; 
            }
        })

        // 4. Get Today's Shifts
        .get('/admin/shifts', async ({ set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return []; }
            try {
                const shifts = await sql`
                    SELECT s.*, u.name as staff_name, u.branch 
                    FROM shifts s 
                    LEFT JOIN users u ON s.user_id = u.id 
                    WHERE s.date = CURRENT_DATE
                    ORDER BY s.clock_in DESC
                `;
                await sql.end();
                return [...shifts];
            } catch (e) { 
                console.error("Admin Shifts Error:", e);
                try { await sql.end(); } catch(err) {}
                return []; 
            }
        })

        // 5. Get Requests
        .get('/admin/requests', async ({ set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return []; }
            try {
                const requests = await sql`
                    SELECT r.*, u.name as receiver_name 
                    FROM requests r 
                    LEFT JOIN users u ON r.receiver_id = u.id 
                    ORDER BY r.created_at DESC 
                    LIMIT 50
                `;
                await sql.end();
                return [...requests];
            } catch (e) { 
                console.error("Admin Requests Error:", e);
                try { await sql.end(); } catch(err) {}
                return []; 
            }
        })

        .get('/admin/users', async ({ set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return []; }
            try { 
                // Explicitly select columns to avoid any ambiguity
                const users = await sql`
                    SELECT id, name, branch, role, bypass_geofence 
                    FROM users 
                    ORDER BY name ASC
                `;
                return [...users]; // Spread into array to ensure clean JSON serialization
            } 
            catch (e) { 
                console.error("Admin Users Error:", e);
                return []; 
            }
        })

        .get('/users/:id/status', async ({ params, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { success: false }; }
            try {
                const [u] = await sql`SELECT bypass_geofence, branch FROM users WHERE id = ${params.id}`;
                return { success: true, can_roam: u.bypass_geofence, branch: u.branch };
            } catch (e) { return { success: false }; }
        })

        // TOGGLE ROAMING PERMISSION
        .put('/admin/users/:id/roam', async ({ params, body, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { success: false }; }
            try {
                // Ensure ID is a number and bypass is a boolean
                const userId = parseInt(params.id);
                const isBypass = Boolean(body.bypass);
                
                await sql`UPDATE users SET bypass_geofence = ${isBypass} WHERE id = ${userId}`;
                return { success: true };
            } catch (e: any) { 
                console.error("Toggle Error:", e);
                return { success: false, message: e.message }; 
            }
        }, { body: t.Object({ bypass: t.Boolean() }) })

        // --- ADMIN: ATTENDANCE PRINTING ---
        .get('/admin/shifts/export', async ({ query, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return []; }
            try {
                const months = parseInt(query.months as string) || 1;
                // Fetch shifts from X months ago until now
                return await sql`
                    SELECT s.*, u.name as staff_name, u.branch 
                    FROM shifts s 
                    JOIN users u ON s.user_id = u.id 
                    WHERE s.date >= (CURRENT_DATE - (${months} || ' month')::INTERVAL)
                    ORDER BY s.date DESC, s.clock_in ASC
                `;
            } catch (e) { return []; }
        })

        // --- ADMIN: HISTORY & LEAVES ---
        .get('/admin/staff-history/:userId', async ({ params, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { shifts: [], leaves: [] }; }
            try {
                const shifts = await sql`SELECT * FROM shifts WHERE user_id = ${params.userId} ORDER BY clock_in DESC LIMIT 50`;
                const leaves = await sql`SELECT * FROM leaves WHERE user_id = ${params.userId} ORDER BY created_at DESC`;
                return { shifts, leaves };
            } catch (e) { return { shifts: [], leaves: [] }; }
        })

        // --- SHIFT LOGIC (UPDATED) ---
        .get('/shift/status/:userId', async ({ params, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { active: false }; }
            const [s] = await sql`SELECT * FROM shifts WHERE user_id = ${params.userId} AND clock_out IS NULL ORDER BY id DESC LIMIT 1`;
            return { active: !!s, shift: s || null };
        })

        .get('/branches', () => Object.keys(BRANCH_LOCATIONS))

        // --- AUTH (Updated to return permission) ---
        .post('/login', async ({ body, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { success: false }; }
            try {
                const [u] = await sql`SELECT * FROM users WHERE username = ${body.username} AND password = ${body.password}`;
                if (u) return { 
                    success: true, 
                    id: u.id, 
                    role: u.role, 
                    name: u.name, 
                    branch: u.branch, 
                    can_roam: u.bypass_geofence // Send permission to frontend
                };
                set.status = 401; return { success: false, message: "Invalid Login" };
            } catch (e) { return { success: false }; }
        }, { body: t.Object({ username: t.String(), password: t.String() }) })

        // --- CLOCK IN (Updated for Branch Selection) ---
        .post('/shift/clock-in', async ({ body, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { success: false, message: "DB Error" }; }
            
            try {
                // 1. Get User
                const [user] = await sql`SELECT branch, bypass_geofence FROM users WHERE id = ${body.user_id}`;
                if (!user) return { success: false, message: "User not found" };

                // 2. Determine Target Branch
                // Logic: If user HAS permission AND SENT a target, use target. Else use Home.
                const hasPermission = user.bypass_geofence;
                const requestedBranch = body.target_branch;
                
                const targetBranch = (hasPermission && requestedBranch) ? requestedBranch : user.branch;
                const branchLoc = BRANCH_LOCATIONS[targetBranch];

                // --- DEBUG LOGGING (Check Vercel Function Logs if this fails) ---
                console.log(`ClockIn: User=${body.user_id}, Perm=${hasPermission}, ReqBranch=${requestedBranch}, FinalTarget=${targetBranch}`);

                // 3. Check Branch Validity
                if (!branchLoc) {
                    return { success: false, message: `Invalid Branch: ${targetBranch}` };
                }

                // 4. Geofence Check
                const dist = getDistance(body.lat, body.lng, branchLoc.lat, branchLoc.lng);
                console.log(`Distance to ${targetBranch}: ${dist}m`); // Debug Log

                if (dist > ALLOWED_RADIUS_METERS) {
                    return { success: false, message: `Too far from ${targetBranch}! (${Math.round(dist)}m away)` };
                }

                // 5. Check Active Shift
                const [active] = await sql`SELECT id FROM shifts WHERE user_id = ${body.user_id} AND clock_out IS NULL`;
                if (active) return { success: false, message: "Already clocked in!" };

                // 6. Save
                const note = body.note ? `${body.note} (at ${targetBranch})` : `(at ${targetBranch})`;
                await sql`
                    INSERT INTO shifts (user_id, clock_in, date, lat, lng, in_note) 
                    VALUES (${body.user_id}, NOW(), CURRENT_DATE, ${String(body.lat)}, ${String(body.lng)}, ${note})
                `;
                return { success: true };
            } catch (e: any) { return { success: false, message: e.message }; }
        }, { body: t.Object({ user_id: t.Number(), lat: t.Number(), lng: t.Number(), note: t.Optional(t.String()), target_branch: t.Optional(t.String()) }) })
        // --- CLOCK OUT (Same Logic) ---
        .post('/shift/clock-out', async ({ body, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { success: false }; }

            try {
                const [user] = await sql`SELECT branch, bypass_geofence FROM users WHERE id = ${body.user_id}`;
                
                // Determine Target (same logic as clock in)
                const targetBranch = (user.bypass_geofence && body.target_branch) ? body.target_branch : user.branch;
                const branchLoc = BRANCH_LOCATIONS[targetBranch];
                
                let remark = null;
                
                if (branchLoc) {
                    const dist = getDistance(body.lat, body.lng, branchLoc.lat, branchLoc.lng);
                    if (dist > ALLOWED_RADIUS_METERS) remark = `⚠️ Off-site: ${Math.round(dist)}m from ${targetBranch}`;
                }

                await sql`
                    UPDATE shifts 
                    SET clock_out = NOW(), out_lat = ${String(body.lat)}, out_lng = ${String(body.lng)}, 
                        remarks = ${remark}, out_note = ${body.note || ''}
                    WHERE user_id = ${body.user_id} AND clock_out IS NULL
                `;
                return { success: true, message: remark ? "Warning: Clocked out off-site" : "Clocked Out" };
            } catch (e: any) { return { success: false, message: e.message }; }
        }, { body: t.Object({ user_id: t.Number(), lat: t.Number(), lng: t.Number(), note: t.Optional(t.String()), target_branch: t.Optional(t.String()) }) })
        
        .get('/shift/logs/:userId', async ({ params, set }) => {
            const sql = getDb();
            if (!sql) return [];
            return await sql`SELECT * FROM shifts WHERE user_id = ${params.userId} ORDER BY clock_in DESC LIMIT 30`;
        })

        // --- LEAVE SYSTEM ---

        .post('/leaves', async ({ body, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { success: false, message: "DB Error" }; }

            const b = body as { user_id: number, leave_type: string, start_date: string, end_date: string, reason: string };
            try {
                await sql`
                    INSERT INTO leaves (user_id, leave_type, start_date, end_date, reason)
                    VALUES (${b.user_id}, ${b.leave_type}, ${b.start_date}, ${b.end_date}, ${b.reason})
                `;
                await sql.end();
                return { success: true };
            } catch (err) {
                console.error("Leave POST Error:", err);
                try { await sql.end(); } catch(e) {}
                return { success: false, message: String(err) };
            }
        }, { 
            body: t.Object({ 
                user_id: t.Number(), 
                leave_type: t.String(), 
                start_date: t.String(), 
                end_date: t.String(), 
                reason: t.String() 
            }) 
        })

        .get('/leaves/:userId', async ({ params, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return []; }
            
            try {
                const leaves = await sql`SELECT * FROM leaves WHERE user_id = ${params.userId} ORDER BY created_at DESC`;
                await sql.end();
                return [...leaves];
            } catch (err) {
                console.error("Leaves GET Error:", err);
                try { await sql.end(); } catch(e) {}
                return [];
            }
        })

        .post('/audits', async ({ body, set }) => {
            const sql = getDb();
            if (!sql) { 
                console.error("Audit POST - DB not connected");
                set.status = 500; 
                return { success: false, message: "DB Error" }; 
            }
            const b = body as any;
            try {
                await sql`
                    INSERT INTO audits (
                        staff_name, staff_branch, date_received, model, storage_color, serial_number, imei,
                        icloud_lock, device_erased, mdm_lock, imei_status, sim_lock, battery_health,
                        charging_test, screen_condition, back_glass, frame_condition, biometrics,
                        camera_condition, audio_condition, connectivity, non_genuine_parts, accessories,
                        grade, remarks
                    ) VALUES (
                        ${b.staff_name}, ${b.staff_branch}, ${b.date_received}, ${b.model}, ${b.storage_color}, ${b.serial_number}, ${b.imei},
                        ${b.icloud_lock}, ${b.device_erased}, ${b.mdm_lock}, ${b.imei_status}, ${b.sim_lock}, ${b.battery_health},
                        ${b.charging_test}, ${b.screen_condition}, ${b.back_glass}, ${b.frame_condition}, ${b.biometrics},
                        ${b.camera_condition}, ${b.audio_condition}, ${b.connectivity}, ${b.non_genuine_parts}, ${b.accessories},
                        ${b.grade}, ${b.remarks}
                    )
                `;
                await sql.end();
                return { success: true };
            } catch (e: any) { 
                console.error("Audit POST error:", e);
                try { await sql.end(); } catch(err) {}
                return { success: false, message: e.message }; 
            }
        })

        .get('/audits', async ({ headers, set }) => {
            const sql = getDb();
            if (!sql) {
                console.error("Audits GET - DB not connected");
                return [];
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                try { await sql.end(); } catch(err) {}
                return []; 
            }
            try {
                const audits = await sql`SELECT * FROM audits ORDER BY created_at DESC LIMIT 50`;
                await sql.end();
                return [...audits];
            } catch (e) { 
                console.error("Audits GET error:", e);
                try { await sql.end(); } catch(err) {}
                return []; 
            }
        })

        .post('/login', async ({ body, set }) => {
            const sql = getDb();
            if (!sql) { 
                console.error("Login - DB not connected");
                set.status = 500; 
                return { success: false, message: "DB Disconnected" }; 
            }
            try {
                const b = body as { username: string; password: string };
                const users = await sql`SELECT * FROM users WHERE username = ${b.username} AND password = ${b.password}`;
                await sql.end();
                
                if (users.length > 0) {
                    return { 
                        success: true, 
                        id: users[0].id,
                        role: users[0].role, 
                        username: users[0].username, 
                        name: users[0].name, 
                        branch: users[0].branch 
                    }; 
                }
                set.status = 401; 
                return { success: false, message: "Invalid ID or Password" };
            } catch (e: any) { 
                console.error("Login error:", e);
                try { await sql.end(); } catch(err) {}
                return { success: false, message: e.message }; 
            }
        }, { body: t.Object({ username: t.String(), password: t.String() }) })

        .get('/users', async ({ set }) => {
            const sql = getDb();
            if (!sql) {
                console.error("Users GET - DB not connected, DATABASE_URL:", process.env.DATABASE_URL ? "present" : "missing");
                set.status = 500;
                return [];
            }
            try {
                console.log("Fetching users from database...");
                const users = await sql`SELECT id, name, branch FROM users ORDER BY name ASC`;
                console.log("Users fetched:", users.length);
                await sql.end();
                // Ensure we return a plain array that can be serialized
                return users.map(u => ({ 
                    id: Number(u.id), 
                    name: String(u.name), 
                    branch: String(u.branch) 
                }));
            } catch (e: any) { 
                console.error("Users GET error:", e.message, e.stack);
                try { await sql.end(); } catch(err) { console.error("Error closing connection:", err); }
                set.status = 500;
                return []; 
            }
        })

        .get('/users/admin', async ({ headers, set }) => {
            const sql = getDb();
            if (!sql) return [];
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401;
                try { await sql.end(); } catch(err) {}
                return []; 
            }
            try {
                const users = await sql`SELECT id, username, role, name, branch FROM users ORDER BY id ASC`;
                await sql.end();
                return [...users];
            } catch (e) { 
                console.error("Users Admin GET error:", e);
                try { await sql.end(); } catch(err) {}
                return []; 
            }
        })

        .put('/users/:id/password', async ({ params, body, set }) => {
            const sql = getDb();
            if (!sql) {
                set.status = 500;
                return { success: false };
            }
            try {
                const b = body as { password: string };
                await sql`UPDATE users SET password = ${b.password} WHERE id = ${params.id}`;
                await sql.end();
                return { success: true };
            } catch (e: any) {
                console.error("Password update error:", e);
                try { await sql.end(); } catch(err) {}
                set.status = 500;
                return { success: false, message: e.message };
            }
        }, { body: t.Object({ password: t.String() }) })

        .get('/requests/:userId', async ({ params, set }) => {
            const sql = getDb();
            if (!sql) {
                console.error("Requests GET - DB not connected");
                set.status = 500;
                return { received: [], sent: [] };
            }
            try {
                const received = await sql`
                    SELECT * FROM requests 
                    WHERE receiver_id = ${params.userId} 
                    ORDER BY created_at DESC
                `;
                const sent = await sql`
                    SELECT r.*, u.name as receiver_name 
                    FROM requests r 
                    LEFT JOIN users u ON r.receiver_id = u.id 
                    WHERE sender_id = ${params.userId} 
                    ORDER BY created_at DESC
                `;
                await sql.end();
                return { received: [...received], sent: [...sent] };
            } catch (e) {
                console.error("Requests GET error:", e);
                try { await sql.end(); } catch(err) {}
                set.status = 500;
                return { received: [], sent: [] };
            }
        })

        .get('/requests/:userId/pending-count', async ({ params, set }) => {
            const sql = getDb();
            if (!sql) { set.status = 500; return { count: 0 }; }
            try {
                // 1. Get total pending count
                const [countResult] = await sql`
                    SELECT COUNT(*) as count 
                    FROM requests 
                    WHERE receiver_id = ${params.userId} AND status = 'pending'
                `;
                
                // 2. Get the specific details of the MOST RECENT pending request
                const [latest] = await sql`
                    SELECT sender_name, content 
                    FROM requests 
                    WHERE receiver_id = ${params.userId} AND status = 'pending' 
                    ORDER BY created_at DESC 
                    LIMIT 1
                `;

                await sql.end();
                return { 
                    count: Number(countResult.count), 
                    latest: latest || null
                };
            } catch (e) { 
                console.error("Pending Count Error:", e);
                try { await sql.end(); } catch(err) {}
                return { count: 0 }; 
            }
        })

        .post('/requests', async ({ body, set }) => {
            const sql = getDb();
            if (!sql) {
                set.status = 500;
                return { success: false };
            }
            try {
                const b = body as { sender_id: number; sender_name: string; receiver_id: number; content: string };
                await sql`
                    INSERT INTO requests (sender_id, sender_name, receiver_id, content) 
                    VALUES (${b.sender_id}, ${b.sender_name}, ${b.receiver_id}, ${b.content})
                `;
                await sql.end();
                return { success: true };
            } catch (e: any) {
                console.error("Request POST error:", e);
                try { await sql.end(); } catch(err) {}
                set.status = 500;
                return { success: false, message: e.message };
            }
        }, { body: t.Object({ sender_id: t.Number(), sender_name: t.String(), receiver_id: t.Number(), content: t.String() }) })

        .put('/requests/:id/status', async ({ params, body, set }) => {
            const sql = getDb();
            if (!sql) {
                set.status = 500;
                return { success: false };
            }
            try {
                const b = body as { status: string; reason?: string };
                
                // Set timestamp based on status
                if (b.status === 'accepted') {
                    await sql`
                        UPDATE requests 
                        SET status = ${b.status}, accepted_at = NOW() 
                        WHERE id = ${params.id}
                    `;
                } else if (b.status === 'completed') {
                    await sql`
                        UPDATE requests 
                        SET status = ${b.status}, completed_at = NOW() 
                        WHERE id = ${params.id}
                    `;
                } else if (b.status === 'rejected') {
                    await sql`
                        UPDATE requests 
                        SET status = ${b.status}, rejection_reason = ${b.reason || 'No reason provided'} 
                        WHERE id = ${params.id}
                    `;
                } else {
                    await sql`UPDATE requests SET status = ${b.status} WHERE id = ${params.id}`;
                }
                
                await sql.end();
                return { success: true };
            } catch (e: any) {
                console.error("Request status update error:", e);
                try { await sql.end(); } catch(err) {}
                set.status = 500;
                return { success: false, message: e.message };
            }
        }, { body: t.Object({ status: t.String(), reason: t.Optional(t.String()) }) })

        .delete('/requests/cleanup', async ({ set }) => {
            const sql = getDb();
            if (!sql) {
                set.status = 500;
                return { success: false, deleted: 0 };
            }
            try {
                // Delete completed requests older than 2 days
                const result = await sql`
                    DELETE FROM requests 
                    WHERE status = 'completed' 
                    AND completed_at < NOW() - INTERVAL '2 days'
                    RETURNING id
                `;
                await sql.end();
                return { success: true, deleted: result.length };
            } catch (e: any) {
                console.error("Cleanup error:", e);
                try { await sql.end(); } catch(err) {}
                set.status = 500;
                return { success: false, deleted: 0, message: e.message };
            }
        })

        .post('/users', async ({ body, headers, set }) => {
            const sql = getDb();
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB Error" };
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401;
                try { await sql.end(); } catch(err) {}
                return { success: false }; 
            }
            try {
                const b = body as any;
                await sql`
                    INSERT INTO users (username, password, role, name, branch) 
                    VALUES (${b.username}, ${b.password}, 'staff', ${b.name}, ${b.branch})
                `;
                await sql.end();
                return { success: true };
            } catch (e: any) { 
                console.error("User creation error:", e);
                try { await sql.end(); } catch(err) {}
                return { success: false, message: e.message }; 
            }
        })

        .delete('/users/:id', async ({ params, headers, set }) => {
            const sql = getDb();
            if (!sql) {
                set.status = 500;
                return { success: false };
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401;
                try { await sql.end(); } catch(err) {}
                return { success: false }; 
            }
            try {
                await sql`DELETE FROM users WHERE id = ${params.id}`;
                await sql.end();
                return { success: true };
            } catch (e: any) {
                console.error("User deletion error:", e);
                try { await sql.end(); } catch(err) {}
                set.status = 500;
                return { success: false, message: e.message };
            }
        })

        .put('/users/:id', async ({ params, body, headers, set }) => {
            const sql = getDb();
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                return { success: false, message: "Unauthorized" }; 
            }
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB Error" };
            }
            
            const b = body as any;
            try {
                await sql`UPDATE users SET password = ${b.password} WHERE id = ${params.id}`;
                await sql.end();
                return { success: true };
            } catch (e: any) { 
                console.error("User update error:", e);
                try { await sql.end(); } catch(err) {}
                return { success: false, message: e.message }; 
            }
        }, { body: t.Object({ password: t.String() }) })
        
        .get('/phones', async ({ set }) => {
            const sql = getDb();
            if (!sql) { 
                console.error("Phones GET - DB not connected");
                set.status = 500; 
                return { error: "Database not connected" }; 
            }
            try {
                const phones = await sql`
                    SELECT phones.*, types.name as type_name 
                    FROM phones 
                    LEFT JOIN types ON phones.type_id = types.id 
                    ORDER BY phones.id DESC
                `;
                await sql.end();
                return [...phones];
            } catch (error: any) { 
                console.error("Phones GET error:", error);
                try { await sql.end(); } catch(err) {}
                set.status = 500;
                return { error: error.message }; 
            }
        })

        .get('/types', async ({ set }) => {
            const sql = getDb();
            if (!sql) {
                console.error("Types GET - DB not connected");
                set.status = 500;
                return [];
            }
            try {
                const types = await sql`SELECT * FROM types ORDER BY name ASC`;
                await sql.end();
                return [...types]; 
            } catch (error: any) { 
                console.error("Types GET error:", error);
                try { await sql.end(); } catch(err) {}
                set.status = 500;
                return []; 
            }
        })

        .post('/types', async ({ body, headers, set }) => {
            const sql = getDb();
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB Error" };
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) {
                set.status = 401;
                try { await sql.end(); } catch(err) {}
                return { success: false };
            }
            try {
                await sql`INSERT INTO types (name) VALUES (${(body as any).name})`;
                await sql.end();
                return { success: true };
            } catch (e: any) { 
                console.error("Type creation error:", e);
                try { await sql.end(); } catch(err) {}
                return { success: false, message: e.message }; 
            }
        }, { body: t.Object({ name: t.String() }) })

        .post('/phones', async ({ body, headers, set }) => {
            const sql = getDb();
            if (!sql) { 
                set.status = 500; 
                return { success: false, message: "DB Error" }; 
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401;
                try { await sql.end(); } catch(err) {}
                return { success: false }; 
            }
            
            const b = body as any;
            try {
                await sql`
                    INSERT INTO phones (model, rrp, type_id, base_price, lcd_amt, aeon_rate, stamping_rate) 
                    VALUES (
                        ${b.model}, 
                        ${b.rrp}, 
                        ${b.type_id},
                        ${b.base_price || 0}, 
                        ${b.lcd_amt || 0}, 
                        ${b.aeon_rate || 0}, 
                        ${b.stamping_rate || 0}
                    )
                `;
                await sql.end();
                return { success: true };
            } catch (e: any) { 
                console.error("Phone creation error:", e);
                try { await sql.end(); } catch(err) {}
                return { success: false, message: e.message }; 
            }
        })    
        
        .put('/phones/:id', async ({ params, body, headers, set }) => {
            const sql = getDb();
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB Error" };
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401;
                try { await sql.end(); } catch(err) {}
                return { success: false }; 
            }
            
            const b = body as any;
            try {
                await sql`
                    UPDATE phones 
                    SET 
                        model = ${b.model}, 
                        rrp = ${b.rrp}, 
                        type_id = ${b.type_id},
                        base_price = ${b.base_price || 0},
                        lcd_amt = ${b.lcd_amt || 0},
                        aeon_rate = ${b.aeon_rate || 0},
                        stamping_rate = ${b.stamping_rate || 0}
                    WHERE id = ${params.id}
                `;
                await sql.end();
                return { success: true };
            } catch (e: any) { 
                console.error("Phone update error:", e);
                try { await sql.end(); } catch(err) {}
                return { success: false, message: e.message }; 
            }
        })

        .delete('/phones/:id', async ({ params, headers, set }) => {
            const sql = getDb();
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB not connected" };
            }

            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) {
                set.status = 401;
                try { await sql.end(); } catch(err) {}
                return { success: false, message: "Wrong Password" };
            }

            try {
                await sql`DELETE FROM phones WHERE id = ${params.id}`;
                await sql.end();
                return { success: true };
            } catch (error: any) {
                console.error("Phone deletion error:", error);
                try { await sql.end(); } catch(err) {}
                set.status = 500;
                return { success: false, message: error.message };
            }
        })
        
        .post('/submit-application', async ({ body, set }: { body: any; set: any }) => {
            try {
                const emailBody = `
                    BORANG PERMOHONAN ANSURAN BARU
                    ===============================
                    NAMA : ${body.nama}
                    KAD PENGENALAN : ${body.ic}
                    ALAMAT : ${body.alamat}
                    TAHUN TINGGAL: ${body.tahun_tinggal}
                    RUMAH : ${body.jenis_rumah}
                    STATUS : ${body.status}
                    ANAK : ${body.anak}
                    HP : ${body.hp}
                    EMEL : ${body.email_user}
                    TARIKH GAJI : ${body.tarikh_gaji}

                    BUTIRAN KERJA
                    NAMA SYARIKAT : ${body.syarikat}
                    ALAMAT : ${body.alamat_kerja}
                    TAHUN BEKERJA: ${body.tahun_kerja}
                    NO PEJABAT : ${body.no_pejabat}
                    JAWATAN : ${body.jawatan}

                    RUJUKAN 1
                    NAMA : ${body.ref1_nama}
                    HUBUNGAN : ${body.ref1_hub}
                    HP : ${body.ref1_hp}

                    RUJUKAN 2
                    NAMA : ${body.ref2_nama}
                    HUBUNGAN : ${body.ref2_hub}
                    HP : ${body.ref2_hp}

                    BUTIRAN BANK
                    BANK : ${body.bank_nama}
                    AKAUN : ${body.bank_acc}
                `;

                const mailOptions = {
                    from: process.env.SMTP_USER,
                    to: process.env.GMAIL_BOSS,
                    replyTo: body.email_user,
                    subject: `PERMOHONAN BARU - ${body.nama}`,
                    text: emailBody,
                    attachments: [
                        { filename: `IC_${body.nama}.png`, content: Buffer.from(await body.icFile.arrayBuffer()) },
                        { filename: `SlipGaji_${body.nama}.png`, content: Buffer.from(await body.salarySlip.arrayBuffer()) }
                    ]
                };

                await transporter.sendMail(mailOptions);
                return { success: true };
            } catch (e: any) {
                console.error("Email submission error:", e);
                set.status = 500;
                return { success: false, message: e.message };
            }
        }, {
            body: t.Object({
                nama: t.String(),
                ic: t.String(),
                alamat: t.String(),
                tahun_tinggal: t.String(),
                jenis_rumah: t.String(),
                status: t.String(),
                anak: t.String(),
                hp: t.String(),
                email_user: t.String(),
                tarikh_gaji: t.String(),
                syarikat: t.String(),
                alamat_kerja: t.String(),
                tahun_kerja: t.String(),
                no_pejabat: t.String(),
                jawatan: t.String(),
                ref1_nama: t.String(),
                ref1_alamat: t.String(),
                ref1_hub: t.String(),
                ref1_hp: t.String(),
                ref2_nama: t.String(),
                ref2_alamat: t.String(),
                ref2_hub: t.String(),
                ref2_hp: t.String(),
                bank_nama: t.String(),
                bank_acc: t.String(),
                icFile: t.File(),
                salarySlip: t.File()
            })
        })
    );

export default app;
