from flask import Flask, request, jsonify
from flask_cors import CORS
import sympy as sp

app = Flask(__name__)
# Sabko allow karne ke liye wildcard lagaya hai
CORS(app, resources={r"/api/*": {"origins": "*"}})

# Yahan dhyaan se dekh, POST ke sath OPTIONS bhi add kiya hai
@app.route('/api/solve', methods=['POST', 'OPTIONS'])
def solve_math():
    # Agar browser security check (OPTIONS) bheje, toh khushi-khushi OK bol do
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    try:
        data = request.get_json()
        expression = data.get('expression', '')
        operation = data.get('operation', 'simplify')
        variable = data.get('variable', 'x')

        if not expression:
            return jsonify({"error": "Expression is missing"}), 400

        # Convert string to mathematical object
        expr = sp.sympify(expression)
        var = sp.Symbol(variable)
        
        result = None

        # Perform the actual hardcore math
        if operation == 'integrate':
            result = sp.integrate(expr, var)
        elif operation == 'derive':
            result = sp.diff(expr, var)
        elif operation == 'solve':
            result = sp.solve(expr, var)
        else:
            result = sp.simplify(expr)

        # Convert result directly to strictly formatted LaTeX
        latex_result = sp.latex(result)

        return jsonify({
            "success": True, 
            "operation": operation,
            "latex": f"$$ {latex_result} $$",
            "raw_answer": str(result)
        })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400
