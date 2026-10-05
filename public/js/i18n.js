/**
 * 三语国际化（简体中文 / English / Bahasa Melayu）
 */
const I18n = (() => {
  const STORAGE_KEY = 'sg-lang';
  const DICT = {
    // 通用
    app_name: { zh: 'StockVerify', en: 'StockVerify', ms: 'StockVerify' },
    app_subtitle: { zh: '扫码出入库 · 离线可用 · GST自动计算', en: 'Scan in/out · Offline · Auto GST', ms: 'Imbas masuk/keluar · Luar talian · GST auto' },
    login: { zh: '登录', en: 'Login', ms: 'Log Masuk' },
    logout: { zh: '退出', en: 'Logout', ms: 'Log Keluar' },
    save: { zh: '保存', en: 'Save', ms: 'Simpan' },
    cancel: { zh: '取消', en: 'Cancel', ms: 'Batal' },
    confirm: { zh: '确认', en: 'Confirm', ms: 'Sahkan' },
    delete: { zh: '删除', en: 'Delete', ms: 'Padam' },
    edit: { zh: '编辑', en: 'Edit', ms: 'Edit' },
    add: { zh: '添加', en: 'Add', ms: 'Tambah' },
    generate: { zh: '生成', en: 'Generate', ms: 'Jana' },
    export_excel: { zh: '导出 Excel', en: 'Export Excel', ms: 'Eksport Excel' },
    back: { zh: '返回', en: 'Back', ms: 'Kembali' },
    // 登录页
    login_title: { zh: 'Hello, my friend!', en: 'Hello, my friend!', ms: 'Hello, my friend!' },
    brand_role: { zh: '品牌方', en: 'Brand', ms: 'Jenama' },
    merchant_role: { zh: '合作商家', en: 'Partner Merchant', ms: 'Peniaga Rakan' },
    card_key: { zh: '登录密码', en: 'Password', ms: 'Kata Laluan' },
    card_key_ph: { zh: '请输入密码', en: 'Enter password', ms: 'Masukkan kata laluan' },
    username: { zh: '用户名', en: 'Username', ms: 'Nama Pengguna' },
    username_ph: { zh: '请输入用户名', en: 'Enter username', ms: 'Masukkan nama pengguna' },
    password: { zh: '密码', en: 'Password', ms: 'Kata Laluan' },
    password_ph: { zh: '请输入密码', en: 'Enter password', ms: 'Masukkan kata laluan' },
    account: { zh: '当前账号', en: 'Account', ms: 'Akaun' },
    login_btn: { zh: '登录系统', en: 'Sign In', ms: 'Log Masuk Sistem' },
    password_hint: { zh: '请输入用户名和密码以继续', en: 'Enter your username and password to continue', ms: 'Masukkan nama pengguna dan kata laluan untuk teruskan' },
    select_role: { zh: '选择登录身份', en: 'Select role', ms: 'Pilih peranan' },
    // 标价（按商品档案）
    fixed_price_label: { zh: '标价', en: 'List Price', ms: 'Harga Senarai' },
    fixed_price_hint: { zh: '标价按商品档案设置，商家可维护', en: 'List price comes from product profile, editable', ms: 'Harga senarai dari profil produk, boleh ubah' },
    // GST 固定（按注册国家）
    gst_fixed_label: { zh: 'GST 税率', en: 'GST Rate', ms: 'Kadar GST' },
    gst_fixed_hint: { zh: '由品牌方开户时按国家确定，商家不可修改', en: 'Set by brand at registration, not editable', ms: 'Ditetapkan jenama semasa pendaftaran' },
    shop_name_fixed_hint: { zh: '店铺名称由品牌方开户时固定，商家不可修改', en: 'Shop name is fixed by brand, not editable', ms: 'Nama kedai ditetapkan jenama, tidak boleh ubah' },
    country_label: { zh: '所在国家/地区', en: 'Country / Region', ms: 'Negara / Wilayah' },
    dev_badge: { zh: '开发中', en: 'In Development', ms: 'Dalam Pembangunan' },
    dev_ship_hint: { zh: '滞销清货 · 独立站/快递/自提 功能开发中，敬请期待', en: 'Slow-moving clearance · standalone site/delivery/pickup coming soon', ms: 'Jualan perlahan · laman/penghantaran/ambil sendiri akan datang' },
    // 底部导航
    nav_home: { zh: '首页', en: 'Home', ms: 'Laman Utama' },
    nav_scan: { zh: '扫码', en: 'Scan', ms: 'Imbasan' },
    nav_products: { zh: '商品', en: 'Products', ms: 'Produk' },
    nav_reports: { zh: '报表', en: 'Reports', ms: 'Laporan' },
    nav_logs: { zh: '日志', en: 'Logs', ms: 'Log' },
    nav_staff: { zh: '员工', en: 'Staff', ms: 'Staf' },
    nav_settings: { zh: '设置', en: 'Settings', ms: 'Tetapan' },
    nav_merchants: { zh: '商家', en: 'Merchants', ms: 'Peniaga' },
    nav_shipments: { zh: '发货', en: 'Shipments', ms: 'Penghantaran' },
    // 仪表盘
    stat_products: { zh: '商品种类', en: 'Product Types', ms: 'Bilangan Produk' },
    stat_low_stock: { zh: '库存预警', en: 'Low Stock', ms: 'Amaran Stok' },
    stat_sales: { zh: '今日销售额', en: "Today's Sales", ms: 'Jualan Hari Ini' },
    stat_gst: { zh: '今日GST', en: "Today's GST", ms: 'GST Hari Ini' },
    weekly_chart: { zh: '近7天销售趋势', en: '7-Day Sales Trend', ms: 'Trend Jualan 7 Hari' },
    quick_actions: { zh: '快捷操作', en: 'Quick Actions', ms: 'Tindakan Pantas' },
    inbound_scan: { zh: '入库扫码', en: 'Inbound Scan', ms: 'Imbas Masuk' },
    outbound_scan: { zh: '出库扫码', en: 'Outbound Scan', ms: 'Imbas Keluar' },
    product_mgmt: { zh: '商品管理', en: 'Products', ms: 'Pengurusan Produk' },
    report_export: { zh: '报表导出', en: 'Reports', ms: 'Laporan' },
    no_sales_data: { zh: '暂无销售数据', en: 'No sales data', ms: 'Tiada data jualan' },
    // 扫码
    scan_inbound_title: { zh: '扫码入库', en: 'Scan Inbound', ms: 'Imbas Masuk Stok' },
    scan_outbound_title: { zh: '扫码出库', en: 'Scan Outbound', ms: 'Imbas Keluar Stok' },
    start_camera: { zh: '启动摄像头扫码', en: 'Start Camera Scan', ms: 'Mula Imbas Kamera' },
    stop_camera: { zh: '停止扫码', en: 'Stop Scan', ms: 'Henti Imbas' },
    manual_barcode: { zh: '或手动输入条码', en: 'Or enter barcode manually', ms: 'Atau masukkan kod bar' },
    scan_confirm: { zh: '确认', en: 'OK', ms: 'OK' },
    current_stock: { zh: '当前库存', en: 'Current Stock', ms: 'Stok Semasa' },
    qty_label_in: { zh: '入库数量', en: 'Inbound Qty', ms: 'Kuantiti Masuk' },
    qty_label_out: { zh: '出库数量', en: 'Outbound Qty', ms: 'Kuantiti Keluar' },
    unit_price: { zh: '单价', en: 'Unit Price', ms: 'Harga Seunit' },
    base_amount: { zh: '不含税基数', en: 'Before GST', ms: 'Sebelum GST' },
    gst_amount: { zh: 'GST', en: 'GST', ms: 'GST' },
    total_amount: { zh: '含税总额', en: 'Total Inc. GST', ms: 'Jumlah Termasuk GST' },
    scan_success: { zh: '操作成功', en: 'Success', ms: 'Berjaya' },
    continue_scan: { zh: '继续扫码', en: 'Continue Scan', ms: 'Imbas Seterusnya' },
    // 商品
    products_title: { zh: '商品管理', en: 'Product Management', ms: 'Pengurusan Produk' },
    search_ph: { zh: '搜索商品名称/条码/SKU', en: 'Search name / barcode / SKU', ms: 'Cari nama / kod bar / SKU' },
    all: { zh: '全部', en: 'All', ms: 'Semua' },
    only_low: { zh: '仅低库存', en: 'Low Stock Only', ms: 'Stok Rendah Sahaja' },
    no_products: { zh: '暂无商品，点击右上角添加', en: 'No products, tap + to add', ms: 'Tiada produk, klik + untuk tambah' },
    barcode: { zh: '条码', en: 'Barcode', ms: 'Kod Bar' },
    sell_price: { zh: '售价', en: 'Sell Price', ms: 'Harga Jual' },
    low_stock_tag: { zh: '低库存', en: 'Low Stock', ms: 'Stok Rendah' },
    stock: { zh: '库存', en: 'Stock', ms: 'Stok' },
    add_product: { zh: '添加商品', en: 'Add Product', ms: 'Tambah Produk' },
    edit_product: { zh: '编辑商品', en: 'Edit Product', ms: 'Edit Produk' },
    batch_import: { zh: '批量导入商品 (CSV)', en: 'Batch Import (CSV)', ms: 'Import Pukal (CSV)' },
    product_name: { zh: '商品名称', en: 'Product Name', ms: 'Nama Produk' },
    sku: { zh: 'SKU', en: 'SKU', ms: 'SKU' },
    category: { zh: '分类', en: 'Category', ms: 'Kategori' },
    cost_price: { zh: '进价', en: 'Cost Price', ms: 'Harga Kos' },
    initial_stock: { zh: '初始库存', en: 'Initial Stock', ms: 'Stok Awal' },
    threshold: { zh: '预警阈值', en: 'Threshold', ms: 'Ambang' },
    // 报表
    reports_title: { zh: '对账报表', en: 'Reconciliation', ms: 'Laporan' },
    filter_cond: { zh: '筛选条件', en: 'Filters', ms: 'Penapis' },
    start_date: { zh: '开始日期', en: 'Start Date', ms: 'Tarikh Mula' },
    end_date: { zh: '结束日期', en: 'End Date', ms: 'Tarikh Tamat' },
    trans_type: { zh: '交易类型', en: 'Type', ms: 'Jenis' },
    all_types: { zh: '全部', en: 'All', ms: 'Semua' },
    only_out: { zh: '仅出库（销售）', en: 'Outbound (Sales)', ms: 'Keluar (Jualan)' },
    only_in: { zh: '仅入库', en: 'Inbound', ms: 'Masuk' },
    gen_report: { zh: '生成报表', en: 'Generate Report', ms: 'Jana Laporan' },
    summary: { zh: '汇总统计', en: 'Summary', ms: 'Ringkasan' },
    trans_count: { zh: '交易笔数', en: 'Transactions', ms: 'Bilangan Transaksi' },
    total_before_gst: { zh: '不含税总额', en: 'Total Before GST', ms: 'Jumlah Sebelum GST' },
    total_gst: { zh: 'GST总额', en: 'Total GST', ms: 'Jumlah GST' },
    total_inc_gst: { zh: '含税总额', en: 'Total Inc. GST', ms: 'Jumlah Termasuk GST' },
    details: { zh: '交易明细', en: 'Details', ms: 'Butiran' },
    time: { zh: '时间', en: 'Time', ms: 'Masa' },
    type: { zh: '类型', en: 'Type', ms: 'Jenis' },
    qty: { zh: '数量', en: 'Qty', ms: 'Kuantiti' },
    operator: { zh: '操作人', en: 'Operator', ms: 'Pengendali' },
    status: { zh: '状态', en: 'Status', ms: 'Status' },
    // 日志
    logs_title: { zh: '操作日志', en: 'Audit Logs', ms: 'Log Audit' },
    no_logs: { zh: '暂无操作日志', en: 'No logs yet', ms: 'Tiada log' },
    verify_logs: { zh: '验证完整性', en: 'Verify Integrity', ms: 'Sahkan Integriti' },
    hash: { zh: '哈希', en: 'Hash', ms: 'Hash' },
    // 员工
    staff_title: { zh: '员工管理', en: 'Staff', ms: 'Pengurusan Staf' },
    merchant: { zh: '商家', en: 'Merchant', ms: 'Peniaga' },
    staff: { zh: '店员', en: 'Staff', ms: 'Staf' },
    // 设置
    settings_title: { zh: '店铺设置', en: 'Shop Settings', ms: 'Tetapan Kedai' },
    shop_name: { zh: '店铺名称', en: 'Shop Name', ms: 'Nama Kedai' },
    shop_card_key: { zh: '登录密码', en: 'Password', ms: 'Kata Laluan' },
    gst_rate: { zh: 'GST税率', en: 'GST Rate', ms: 'Kadar GST' },
    sys_info: { zh: '系统信息', en: 'System Info', ms: 'Maklumat Sistem' },
    save_settings: { zh: '保存设置', en: 'Save Settings', ms: 'Simpan Tetapan' },
    // 品牌方：商家总览
    merchants_title: { zh: '合作商家', en: 'Partner Merchants', ms: 'Peniaga Rakan' },
    merchant_name: { zh: '商家名称', en: 'Merchant Name', ms: 'Nama Peniaga' },
    product_count: { zh: '商品数', en: 'Products', ms: 'Produk' },
    total_stock: { zh: '总库存', en: 'Total Stock', ms: 'Jumlah Stok' },
    today_sales: { zh: '今日销售额', en: "Today's Sales", ms: 'Jualan Hari Ini' },
    pending_ship: { zh: '待收货', en: 'Pending', ms: 'Menunggu' },
    view_detail: { zh: '查看', en: 'View', ms: 'Lihat' },
    register_merchant: { zh: '注册新商家', en: 'Register Merchant', ms: 'Daftar Peniaga' },
    no_merchants: { zh: '暂无合作商家，请先在注册页开通', en: 'No merchants yet', ms: 'Tiada peniaga' },
    brand_dashboard: { zh: '品牌总览', en: 'Brand Overview', ms: 'Gambaran Jenama' },
    // 发货单
    shipments_title: { zh: '发货管理', en: 'Shipments', ms: 'Pengurusan Penghantaran' },
    new_shipment: { zh: '新建发货单', en: 'New Shipment', ms: 'Penghantaran Baru' },
    select_merchant: { zh: '选择合作商家', en: 'Select Merchant', ms: 'Pilih Peniaga' },
    add_item: { zh: '添加商品', en: 'Add Item', ms: 'Tambah Item' },
    item_barcode: { zh: '条码', en: 'Barcode', ms: 'Kod Bar' },
    item_name: { zh: '商品名称', en: 'Product Name', ms: 'Nama Produk' },
    item_qty: { zh: '数量', en: 'Qty', ms: 'Kuantiti' },
    packing_scan: { zh: '清点扫码', en: 'Packing Scan', ms: 'Imbas Pengiraan' },
    confirm_ship: { zh: '确认发货', en: 'Confirm Ship', ms: 'Sahkan Penghantaran' },
    scanned: { zh: '已扫', en: 'Scanned', ms: 'Dimbas' },
    of: { zh: '/', en: '/', ms: '/' },
    draft: { zh: '草稿', en: 'Draft', ms: 'Draf' },
    shipped: { zh: '已发货', en: 'Shipped', ms: 'Dihantar' },
    received: { zh: '已收货', en: 'Received', ms: 'Diterima' },
    scan_to_count: { zh: '逐件扫码清点', en: 'Scan each item to count', ms: 'Imbas setiap item' },
    ship_hint: { zh: '所有商品扫满后方可发货', en: 'Ship after all items scanned', ms: 'Hantar selepas semua diimbas' },
    // 离线/Toast
    offline: { zh: '离线模式，API不可用', en: 'Offline mode, API unavailable', ms: 'Mod luar talian, API tidak tersedia' },
    network_down: { zh: '网络已断开，扫码记录将保存在本地', en: 'Offline, scans saved locally', ms: 'Rangkaian terputus, imbasan disimpan' },
    syncing: { zh: '正在同步数据...', en: 'Syncing...', ms: 'Menyegerakkan...' },
    pending_upload: { zh: '待上传', en: 'Pending Upload', ms: 'Menunggu Muat Naik' },
    login_success: { zh: '登录成功，欢迎', en: 'Welcome', ms: 'Selamat datang' },
    logout_success: { zh: '已退出登录', en: 'Logged out', ms: 'Telah log keluar' },
    verify_pass: { zh: '日志完整性验证通过', en: 'Log integrity verified', ms: 'Integriti log disahkan' },
    verify_fail: { zh: '日志可能被篡改', en: 'Log may be tampered', ms: 'Log mungkin diubah' },
    verify_mark: { zh: '核对通过', en: 'Verified', ms: 'Disahkan' },
    verify_fail_mark: { zh: '核对失败', en: 'Mismatch', ms: 'Tidak Sepadan' },
    items: { zh: '商品清单', en: 'Items', ms: 'Senarai Item' },
    offline_storage: { zh: '离线存储: IndexedDB', en: 'Offline Storage: IndexedDB', ms: 'Storan Luar Talian: IndexedDB' },
    // 品牌角色名称
    role_brand: { zh: '品牌管理员', en: 'Brand Admin', ms: 'Pentadbir Jenama' },
    role_merchant: { zh: '商家', en: 'Merchant', ms: 'Peniaga' },
    role_staff: { zh: '店员', en: 'Staff', ms: 'Staf' },
    // 设置页更多功能
    more: { zh: '更多功能', en: 'More', ms: 'Lagi' },
    // 品牌管理平台（admin.html）
    admin_title: { zh: 'StockVerify 品牌管理', en: 'StockVerify Brand Portal', ms: 'Portal Jenama StockVerify' },
    admin_role_brand: { zh: '地区代理', en: 'Regional Distributor', ms: 'Pengedar Serantau' },
    admin_role_admin: { zh: 'StockVerify HQ', en: 'StockVerify HQ', ms: 'StockVerify HQ' },
    admin_login_sub: { zh: '地区代理：开通商家 · 发货 · 审核 | 峪锦：查看全部流水', en: 'Distributor: open merchants · ship · review | HQ: view all records', ms: 'Pengedar: buka peniaga · hantar · semak | HQ: lihat semua rekod' },
    admin_brands: { zh: '地区代理列表', en: 'Distributors', ms: 'Senarai Pengedar' },
    admin_merchants: { zh: '合作商家', en: 'Merchants', ms: 'Peniaga' },
    admin_register_brand: { zh: '注册地区代理', en: 'Register Distributor', ms: 'Daftar Pengedar' },
    admin_register_merchant: { zh: '开通商家', en: 'Open Merchant', ms: 'Buka Peniaga' },
    admin_merchant_count: { zh: '商家数', en: 'Merchants', ms: 'Bilangan Peniaga' },
    admin_my_merchants: { zh: '我的合作商家', en: 'My Merchants', ms: 'Peniaga Saya' },
    admin_sales: { zh: '销售额', en: 'Sales', ms: 'Jualan' },
    admin_products: { zh: '商品数', en: 'Products', ms: 'Produk' },
    admin_stock: { zh: '库存', en: 'Stock', ms: 'Stok' },
    admin_pending_ship: { zh: '待收货', en: 'Pending', ms: 'Menunggu' },
    admin_new_merchant_name: { zh: '商家店铺名称', en: 'Merchant shop name', ms: 'Nama kedai peniaga' },
    admin_new_brand_name: { zh: '品牌方名称', en: 'Brand name', ms: 'Nama jenama' },
    admin_generate: { zh: '生成密码', en: 'Generate Password', ms: 'Jana Kata Laluan' },
    admin_card_generated: { zh: '开户成功！登录密码：', en: 'Account created! Password:', ms: 'Akaun dicipta! Kata laluan:' },
    admin_card_hint: { zh: '请复制并发给商家（仅显示一次）', en: 'Copy and send to the merchant (shown once)', ms: 'Salin dan hantar kepada peniaga (sekali sahaja)' },
    admin_copy: { zh: '复制密码', en: 'Copy Password', ms: 'Salin Kata Laluan' },
    admin_copied: { zh: '已复制到剪贴板', en: 'Copied to clipboard', ms: 'Disalin ke papan klip' },
    admin_need_name: { zh: '请输入名称', en: 'Enter a name', ms: 'Masukkan nama' },
    admin_need_brand: { zh: '请先选择品牌方', en: 'Select a brand first', ms: 'Pilih jenama dahulu' },
    admin_country: { zh: '所在国家/地区（决定 GST）', en: 'Country / Region (sets GST)', ms: 'Negara / Wilayah (tetapkan GST)' },
    admin_country_sg: { zh: '新加坡 Singapore · GST 9%', en: 'Singapore · GST 9%', ms: 'Singapura · GST 9%' },
    admin_country_my: { zh: '马来西亚 Malaysia · GST 6%', en: 'Malaysia · GST 6%', ms: 'Malaysia · GST 6%' },
    admin_country_cn: { zh: '中国 China · GST 0%', en: 'China · GST 0%', ms: 'China · GST 0%' },
    admin_country_hint: { zh: 'GST 由开户时国家确定，商家端不可修改', en: 'GST set by country at registration', ms: 'GST ditetapkan oleh negara semasa pendaftaran' },
    admin_country_locked_hint: { zh: '地区跟随品牌方（由管理端设定），不可修改', en: 'Region follows the brand (set by admin), not editable', ms: 'Wilayah ikut jenama (ditetapkan admin), tidak boleh ubah' },
    admin_brand_country_hint: { zh: '品牌地区由管理端设定，该品牌下商家均为此地区', en: 'Brand region set by admin; all its merchants use this region', ms: 'Wilayah jenama ditetapkan admin; semua peniaga guna wilayah ini' },
    admin_delete_title: { zh: '删除账户', en: 'Delete Account', ms: 'Padam Akaun' },
    admin_accounts: { zh: '管理端账户', en: 'Admin Accounts', ms: 'Akaun Admin' },
    admin_account_list: { zh: '账户列表', en: 'Account List', ms: 'Senarai Akaun' },
    admin_register_admin: { zh: '注册管理端', en: 'Register Admin', ms: 'Daftar Admin' },
    admin_new_admin_name: { zh: '管理端名称', en: 'Admin name', ms: 'Nama admin' },
    admin_super: { zh: '超管', en: 'Super Admin', ms: 'Super Admin' },
    admin_normal: { zh: '普通', en: 'Normal', ms: 'Biasa' },
    admin_password_hidden: { zh: '密码隐藏（仅超管可见）', en: 'Password hidden (super admin only)', ms: 'Kata laluan disembunyi (super admin sahaja)' },
    admin_no_permission: { zh: '无权限，仅超管可执行此操作', en: 'No permission. Super admin only.', ms: 'Tiada kebenaran. Super admin sahaja.' },
    change_password: { zh: '修改密码', en: 'Change Password', ms: 'Tukar Kata Laluan' },
    new_password: { zh: '新密码', en: 'New Password', ms: 'Kata Laluan Baharu' },
    confirm_password: { zh: '确认新密码', en: 'Confirm Password', ms: 'Sahkan Kata Laluan' },
    password_rule: { zh: '至少8位，须含大写字母、小写字母、数字和特殊字符（如 !@#$%^&*）', en: 'Min 8 chars with uppercase, lowercase, number & symbol (e.g. !@#$%^&*)', ms: 'Min 8 aksara dengan huruf besar, kecil, nombor & simbol (cth. !@#$%^&*)' },
    password_one_time: { zh: '注意：密码仅可修改一次，请妥善保管', en: 'Note: Password can only be changed once', ms: 'Nota: Kata laluan hanya boleh ditukar sekali' },
    password_mismatch: { zh: '两次密码不一致', en: 'Passwords do not match', ms: 'Kata laluan tidak sepadan' },
    password_changed: { zh: '密码修改成功', en: 'Password changed', ms: 'Kata laluan ditukar' },
    admin_merchant_detail: { zh: '商家详情', en: 'Merchant Detail', ms: 'Butiran Peniaga' },
    admin_card_key: { zh: '初始密码', en: 'Initial Password', ms: 'Kata Laluan Awal' },
    admin_created_at: { zh: '开通时间', en: 'Created', ms: 'Dibuka' },
    admin_no_brands: { zh: '暂无品牌方', en: 'No brands', ms: 'Tiada jenama' },
    admin_no_merchants: { zh: '暂无合作商家', en: 'No merchants', ms: 'Tiada peniaga' },
    admin_register_hint: { zh: '品牌方在此查看销售数据并为合作商家开通账号', en: 'Brands view sales and open merchant accounts here', ms: 'Jenama lihat jualan dan buka akaun peniaga di sini' },
    admin_trans: { zh: '交易记录', en: 'Transactions', ms: 'Transaksi' },
    admin_back_brands: { zh: '返回品牌列表', en: 'Back to Brands', ms: 'Kembali ke Senarai Jenama' },
    admin_back_merchants: { zh: '返回商家列表', en: 'Back to Merchants', ms: 'Kembali ke Senarai Peniaga' },
    admin_shipments: { zh: '发货管理', en: 'Shipments', ms: 'Penghantaran' },
    admin_new_shipment: { zh: '新建发货单', en: 'New Shipment', ms: 'Penghantaran Baru' },
    admin_packing_scan: { zh: '清点扫码', en: 'Packing Scan', ms: 'Imbas Pengiraan' },
    admin_ship_hint: { zh: '所有商品扫满后方可发货', en: 'Ship after all items scanned', ms: 'Hantar selepas semua diimbas' },
    admin_confirm_ship: { zh: '确认发货', en: 'Confirm Ship', ms: 'Sahkan Penghantaran' },
    admin_select_merchant: { zh: '选择合作商家', en: 'Select Merchant', ms: 'Pilih Peniaga' },
    admin_add_item: { zh: '添加商品', en: 'Add Item', ms: 'Tambah Item' },
    admin_scanned: { zh: '已扫', en: 'Scanned', ms: 'Dimbas' },
    admin_received: { zh: '已收', en: 'Received', ms: 'Diterima' },
    admin_draft: { zh: '草稿', en: 'Draft', ms: 'Draf' },
    admin_shipped: { zh: '已发货', en: 'Shipped', ms: 'Dihantar' },
    admin_received_status: { zh: '已收货', en: 'Received', ms: 'Diterima' },
    admin_logout: { zh: '退出登录', en: 'Logout', ms: 'Log Keluar' },
    admin_back_login: { zh: '返回登录', en: 'Back to Login', ms: 'Kembali ke Log Masuk' },
    admin_no_shipments: { zh: '暂无发货单', en: 'No shipments', ms: 'Tiada penghantaran' },
    admin_ship_ok: { zh: '已发货，商家可扫码收货', en: 'Shipped, merchant can receive', ms: 'Dihantar, peniaga boleh terima' },
    // 活动折扣
    discount_label: { zh: '活动折扣（与中医馆合作 · 品牌活动）', en: 'Promo Discount (TCM clinic collab)', ms: 'Diskaun Promosi (kerjasama klinik TCM)' },
    discount_none: { zh: '无折扣', en: 'No discount', ms: 'Tiada diskaun' },
    discount_medical: { zh: '中医馆消费凭证 −S$10', en: 'TCM receipt −S$10', ms: 'Resit TCM −S$10' },
    discount_social: { zh: '社媒分享截图 −S$10', en: 'Social media share −S$10', ms: 'Kongsi media sosial −S$10' },
    discount_both: { zh: '两项都满足 −S$20', en: 'Both −S$20', ms: 'Kedua-duanya −S$20' },
    discount_hint: { zh: '折扣从品牌分成中扣除 · GST 按折后金额计算', en: 'Discount deducted from brand share · GST on discounted amount', ms: 'Diskaun ditolak daripada bahagian jenama · GST atas amaun diskaun' },
    discount_medical_img: { zh: '① 中医馆消费凭证图片', en: '① TCM receipt photo', ms: '① Foto resit TCM' },
    discount_social_img: { zh: '② 社媒分享截图', en: '② Social media share', ms: '② Kongsi media sosial' },
    tap_to_upload: { zh: '点击上传图片', en: 'Tap to upload', ms: 'Klik untuk muat naik' },
    uploaded: { zh: '图片已上传', en: 'Image uploaded', ms: 'Imej dimuat naik' },
    need_medical_img: { zh: '请上传中医馆消费凭证图片', en: 'Please upload TCM receipt', ms: 'Sila muat naik resit TCM' },
    need_social_img: { zh: '请上传社媒分享截图', en: 'Please upload social media share', ms: 'Sila muat naik kongsi media sosial' },
    discount_amount: { zh: '活动折扣', en: 'Discount', ms: 'Diskaun' },
    admin_discounts: { zh: '折扣审核', en: 'Discount Review', ms: 'Semakan Diskaun' },
    admin_discounts_hint: { zh: '审核合作商家上传的活动折扣凭证（中医馆消费凭证 −10 / 社媒分享 −10）', en: 'Review promo discount proofs (TCM receipt −10 / social share −10)', ms: 'Semak bukti diskaun promosi (resit TCM −10 / kongsi sosmed −10)' },
    admin_no_discounts: { zh: '暂无待审核的折扣单', en: 'No pending discount reviews', ms: 'Tiada diskaun untuk disemak' },
    admin_approve: { zh: '通过', en: 'Approve', ms: 'Lulus' },
    admin_reject: { zh: '驳回', en: 'Reject', ms: 'Tolak' },
    admin_reject_confirm: { zh: '确定驳回该折扣吗？折扣将被撤销，按原价结算。', en: 'Reject this discount? It will be revoked.', ms: 'Tolak diskaun ini? Ia akan dibatalkan.' },
    admin_approved: { zh: '已通过，折扣生效', en: 'Approved, discount applied', ms: 'Diluluskan, diskaun digunakan' },
    admin_rejected: { zh: '已驳回，折扣撤销', en: 'Rejected, discount revoked', ms: 'Ditolak, diskaun dibatalkan' },
    // 分成
    brand_share: { zh: '品牌分成', en: 'Brand Share', ms: 'Bahagian Jenama' },
    merchant_share: { zh: '商家分成', en: 'Merchant Share', ms: 'Bahagian Peniaga' },
    // 进货
    nav_purchase: { zh: '进货', en: 'Restock', ms: 'Stok Masuk' },
    purchase_title: { zh: '进货申请', en: 'Restock Request', ms: 'Permohonan Stok' },
    purchase_product: { zh: '选择商品', en: 'Select product', ms: 'Pilih produk' },
    purchase_sel_ph: { zh: '请选择要进货的商品', en: 'Select a product to restock', ms: 'Pilih produk untuk stok' },
    purchase_noproduct: { zh: '暂无商品，请等待品牌方发货后再进货', en: 'No products yet, wait for brand shipment', ms: 'Tiada produk, tunggu penghantaran jenama' },
    purchase_qty: { zh: '进货数量', en: 'Quantity', ms: 'Kuantiti' },
    purchase_cost_hint: { zh: '品牌供货价 S$20 / 个（品牌链路业务规则）', en: 'Brand supply price S$20/unit', ms: 'Harga bekalan jenama S$20/unit' },
    purchase_pay_img: { zh: '付款截图凭证', en: 'Payment proof', ms: 'Bukti pembayaran' },
    purchase_total: { zh: '进货合计', en: 'Total cost', ms: 'Jumlah kos' },
    purchase_submit: { zh: '提交进货申请', en: 'Submit request', ms: 'Hantar permohonan' },
    purchase_history: { zh: '进货记录', en: 'Request history', ms: 'Sejarah permohonan' },
    purchase_need_product: { zh: '请选择商品', en: 'Select a product', ms: 'Sila pilih produk' },
    purchase_need_qty: { zh: '请输入进货数量', en: 'Enter quantity', ms: 'Sila masukkan kuantiti' },
    purchase_need_pay: { zh: '请上传付款截图凭证', en: 'Upload payment proof', ms: 'Sila muat naik bukti pembayaran' },
    purchase_submitted: { zh: '进货申请已提交，等待品牌方审核', en: 'Request submitted, awaiting brand review', ms: 'Permohonan dihantar, menunggu semakan' },
    purchase_none: { zh: '暂无进货记录', en: 'No restock requests', ms: 'Tiada permohonan stok' },
    purchase_cost: { zh: '进货价', en: 'Cost', ms: 'Kos' },
    po_pending: { zh: '待审核', en: 'Pending', ms: 'Menunggu' },
    po_approved: { zh: '已通过', en: 'Approved', ms: 'Diluluskan' },
    po_rejected: { zh: '已驳回', en: 'Rejected', ms: 'Ditolak' },
    admin_purchase: { zh: '进货审核', en: 'Restock Review', ms: 'Semakan Stok' },
    admin_purchase_hint: { zh: '审核合作商家的进货申请（品牌供货价 S$20/个 · 核对付款截图）', en: 'Review merchant restock requests (S$20/unit · check payment proof)', ms: 'Semak permohonan stok peniaga (S$20/unit · semak bukti bayaran)' },
    admin_no_purchase: { zh: '暂无进货申请', en: 'No restock requests', ms: 'Tiada permohonan stok' },
    admin_po_reject_confirm: { zh: '确定驳回该进货申请吗？', en: 'Reject this restock request?', ms: 'Tolak permohonan stok ini?' },
    admin_po_approved: { zh: '已通过进货申请', en: 'Restock approved', ms: 'Stok diluluskan' },
    admin_po_rejected: { zh: '已驳回进货申请', en: 'Restock rejected', ms: 'Stok ditolak' }
  };

  // 允许语言：zh/en/ms
  const LANGS = ['zh', 'en', 'ms'];

  function getLang() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGS.includes(saved)) return saved;
    return 'zh';
  }

  function setLang(lang) {
    if (!LANGS.includes(lang)) lang = 'zh';
    localStorage.setItem(STORAGE_KEY, lang);
    document.documentElement.lang = lang;
    apply();
    return lang;
  }

  function t(key) {
    const lang = getLang();
    const entry = DICT[key];
    if (!entry) return key;
    return entry[lang] || entry.zh || key;
  }

  // 应用静态 data-i18n 属性
  function apply() {
    const lang = getLang();
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const entry = DICT[key];
      if (entry) {
        const val = entry[lang] || entry.zh;
        if (el.tagName === 'INPUT' && el.hasAttribute('placeholder')) {
          el.setAttribute('placeholder', val);
        } else {
          el.textContent = val;
        }
      }
    });
    // 更新切换器高亮
    document.querySelectorAll('[data-lang-btn]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-lang-btn') === getLang());
    });
    // 通知应用层重渲染动态内容
    if (window.__onLangChange) {
      try { window.__onLangChange(getLang()); } catch (e) {}
    }
  }

  function init() {
    const lang = getLang();
    document.documentElement.lang = lang;
    // 绑定语言按钮
    document.querySelectorAll('[data-lang-btn]').forEach(btn => {
      btn.addEventListener('click', () => setLang(btn.getAttribute('data-lang-btn')));
    });
    apply();
    return lang;
  }

  return { init, setLang, getLang, t, apply };
})();
