"""
Generate synthetic test data with known fraud patterns.
Run: python generate_test_data.py
"""

import csv
import random
from datetime import datetime, timedelta

random.seed(42)

transactions = []
txn_id = 1

def add_txn(sender, receiver, amount, timestamp):
    global txn_id
    transactions.append({
        "transaction_id": f"TXN_{txn_id:05d}",
        "sender_id": sender,
        "receiver_id": receiver,
        "amount": round(amount, 2),
        "timestamp": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
    })
    txn_id += 1

base_time = datetime(2025, 6, 1, 10, 0, 0)

# Pattern 1: Cycle of 3
add_txn("ACC_001", "ACC_002", 5000, base_time + timedelta(hours=1))
add_txn("ACC_002", "ACC_003", 4800, base_time + timedelta(hours=3))
add_txn("ACC_003", "ACC_001", 4600, base_time + timedelta(hours=5))

# Pattern 2: Cycle of 4
add_txn("ACC_010", "ACC_011", 10000, base_time + timedelta(hours=2))
add_txn("ACC_011", "ACC_012", 9500, base_time + timedelta(hours=4))
add_txn("ACC_012", "ACC_013", 9000, base_time + timedelta(hours=6))
add_txn("ACC_013", "ACC_010", 8500, base_time + timedelta(hours=8))

# Pattern 3: Fan-in (12 senders -> 1 hub within 48hrs)
for i in range(12):
    add_txn(f"ACC_FIN_{i+1:03d}", "ACC_HUB_01",
        random.uniform(500, 2000),
        base_time + timedelta(hours=random.randint(1, 48)))
add_txn("ACC_HUB_01", "ACC_DEST_01", 15000, base_time + timedelta(hours=50))

# Pattern 4: Fan-out (1 hub -> 12 receivers within 24hrs)
add_txn("ACC_SOURCE_01", "ACC_HUB_02", 20000, base_time + timedelta(hours=1))
for i in range(12):
    add_txn("ACC_HUB_02", f"ACC_FOUT_{i+1:03d}",
        random.uniform(1000, 2500),
        base_time + timedelta(hours=2 + random.randint(0, 24)))

# Pattern 5: Shell chain
add_txn("ACC_ORIG_01", "ACC_SHELL_A", 7000, base_time + timedelta(hours=1))
add_txn("ACC_SHELL_A", "ACC_SHELL_B", 6800, base_time + timedelta(hours=3))
add_txn("ACC_SHELL_B", "ACC_SHELL_C", 6500, base_time + timedelta(hours=5))
add_txn("ACC_SHELL_C", "ACC_FINAL_01", 6200, base_time + timedelta(hours=7))

# TRAP: Legitimate Merchant (should NOT be flagged)
for i in range(25):
    add_txn(f"ACC_CUST_{i+1:03d}", "ACC_MERCHANT_01",
        random.uniform(10, 500),
        base_time + timedelta(days=random.randint(0, 90), hours=random.randint(0, 23)))
for i in range(8):
    add_txn("ACC_MERCHANT_01", f"ACC_SUPPLIER_{i+1:03d}",
        random.uniform(100, 1000),
        base_time + timedelta(days=random.randint(0, 90)))

# TRAP: Payroll Account (should NOT be flagged)
for month in range(3):
    for emp in range(20):
        add_txn("ACC_PAYROLL_01", f"ACC_EMP_{emp+1:03d}",
            3500.00,
            base_time + timedelta(days=30 * month))

# Background noise
for i in range(100):
    s = f"ACC_RAND_{random.randint(1, 50):03d}"
    r = f"ACC_RAND_{random.randint(51, 100):03d}"
    add_txn(s, r, random.uniform(50, 5000),
        base_time + timedelta(days=random.randint(0, 60), hours=random.randint(0, 23)))

with open("test_data.csv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["transaction_id", "sender_id", "receiver_id", "amount", "timestamp"])
    writer.writeheader()
    writer.writerows(transactions)

print(f"Generated {len(transactions)} transactions -> test_data.csv")